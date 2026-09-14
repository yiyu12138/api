package com.avhlune.apibalance;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;
import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.PSSParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String APK_URL = "https://github.com/yiyu12138/api/releases/latest/download/api-balance.apk";
    private static final String LICENSE_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuqqErB8WIwvA2gqfCEL+rJVtsiN8zYo6GvEPyT4GCwuybHziX4OfQmBO2y+D75MAkTipJNFNT51OJbZbUwp8GYk/4UuyQmdiheVyZTdBW2FURKUnQaC2esgAhI1onpuTvumHTDgCJDwW2BFNYdw063F7Re+VlcBJ1piLPdxyrQA94Saw5bQieFJuJS0r6p+HCW/UEuMM9PvdkEXGiXj/MOjCzjW1Hvm+e0Bglr2NsLgMdbHHciKjNzrMAL8W6NOLCOgThtr/dEG4y5XEnsKF/tDYVAJeaKxv46GQo7Z0WNXUwu+pj0GTFgkF7wQOSJ5ums/moKla0nhGxH2nQyFvFwIDAQAB";
    private static final int FILE_CHOOSER = 41;
    private static final int EXPORT_FILE = 42;

    private final ExecutorService network = Executors.newCachedThreadPool();
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private volatile long updateDownloadId = -1;
    private Uri pendingInstallUri;
    private boolean installerActive;
    private String pendingExport;

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id != updateDownloadId) return;
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
                if (cursor == null || !cursor.moveToFirst()) return;
                int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                    updateDownloadId = -1;
                    installDownloadedUpdate();
                } else if (status == DownloadManager.STATUS_FAILED) {
                    int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    sendDownloadState("failed", 0, 0, reason);
                    updateDownloadId = -1;
                    toast("APK 下载失败，请检查网络后重试");
                }
            }
        }
    };

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(238, 241, 247));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " APIBalanceAndroid/" + getVersionName());
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidApp");
        webView.setWebChromeClient(new AppChromeClient());
        webView.setWebViewClient(new AppWebViewClient());
        webView.setDownloadListener(new AppDownloadListener());

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(downloadReceiver, filter);
        webView.loadUrl("file:///android_asset/index.html");
    }

    private String getVersionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception error) { return ""; }
    }

    private String loadState() {
        return LocalStore.load(this);
    }

    private void saveState(String value) {
        if (!LocalStore.save(this, value)) toast("本地配置保存失败");
    }

    private boolean verifyLicense(String code, String installId) {
        return verifyLicenseCode(code, installId);
    }

    static boolean verifyLicenseCode(String code, String installId) {
        try {
            String[] parts = code == null ? new String[0] : code.trim().split("\\.", -1);
            if (parts.length != 2 || parts[0].isEmpty() || parts[1].isEmpty()) return false;
            JSONObject payload = new JSONObject(new String(Base64.decode(parts[0], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8));
            if (payload.optInt("version") != 1 || !"pro".equals(payload.optString("plan"))) return false;
            if (!installId.equals(payload.optString("installId")) || payload.optString("licenseId").isEmpty()) return false;
            long expiresAt = payload.optLong("expiresAt", 0);
            if (expiresAt > 0 && System.currentTimeMillis() >= expiresAt) return false;
            PublicKey publicKey = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.decode(LICENSE_PUBLIC_KEY, Base64.DEFAULT)));
            Signature verifier;
            try {
                verifier = Signature.getInstance("SHA256withRSA/PSS");
                verifier.initVerify(publicKey);
            } catch (NoSuchAlgorithmException unsupportedAndroidAlias) {
                verifier = Signature.getInstance("RSASSA-PSS");
                verifier.initVerify(publicKey);
                verifier.setParameter(new PSSParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, 32, 1));
            }
            verifier.update(parts[0].getBytes(StandardCharsets.UTF_8));
            return verifier.verify(Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
        } catch (Exception error) { return false; }
    }

    private void httpRequest(String id, String requestJson) {
        network.execute(() -> {
            JSONObject output;
            try {
                output = NativeHttp.request(new JSONObject(requestJson));
            } catch (Exception error) {
                output = new JSONObject();
                try { output.put("error", error.getMessage() == null ? "网络请求失败" : error.getMessage()); }
                catch (Exception ignored) { }
            }
            String callback = "window.APIBalanceNative.resolve(" + JSONObject.quote(id) + "," + JSONObject.quote(output.toString()) + ")";
            runOnUiThread(() -> { if (webView != null) webView.evaluateJavascript(callback, null); });
        });
    }

    private void saveExport(String json) {
        pendingExport = json;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json")
            .putExtra(Intent.EXTRA_TITLE, "api-balance-config-" + System.currentTimeMillis() + ".json");
        try { startActivityForResult(intent, EXPORT_FILE); }
        catch (Exception error) { pendingExport = null; toast("无法打开文件保存窗口"); }
    }

    private void downloadUpdate() {
        if (updateDownloadId != -1) { toast("安装包正在下载"); return; }
        File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null) { toast("无法访问下载目录"); return; }
        File target = new File(directory, "api-balance-update.apk");
        if (target.exists() && !target.delete()) { toast("无法覆盖旧安装包"); return; }
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(APK_URL))
            .setTitle("API Balance 更新")
            .setDescription("正在下载最新版安装包")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, target.getName());
        try {
            updateDownloadId = ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            sendDownloadState("queued", 0, -1, 0);
            long downloadId = updateDownloadId;
            network.execute(() -> trackDownload(downloadId));
            toast("开始下载 APK");
        } catch (Exception error) {
            updateDownloadId = -1;
            sendDownloadState("failed", 0, 0, 0);
            toast("无法启动 APK 下载");
        }
    }

    private File downloadedUpdateFile() {
        File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        return directory == null ? null : new File(directory, "api-balance-update.apk");
    }

    private void installDownloadedUpdate() {
        File target = downloadedUpdateFile();
        if (target == null || !target.isFile() || target.length() == 0) {
            sendDownloadState("failed", 0, 0, 0);
            toast("未找到已下载的安装包，请重新下载");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", target);
            sendDownloadState("ready", target.length(), target.length(), 0);
            installApk(uri);
        } catch (Exception error) {
            sendDownloadState("failed", target.length(), target.length(), 0);
            toast("无法读取下载的安装包，请重新下载");
        }
    }

    private void trackDownload(long id) {
        DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        int lastStatus = -1;
        int lastProgress = -2;
        while (id == updateDownloadId && !Thread.currentThread().isInterrupted()) {
            try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
                if (cursor == null || !cursor.moveToFirst()) return;
                int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                int progress = total > 0 ? (int) Math.min(100, downloaded * 100 / total) : -1;
                if (status != lastStatus || progress != lastProgress) {
                    String state = status == DownloadManager.STATUS_RUNNING ? "running"
                        : status == DownloadManager.STATUS_PAUSED ? "paused"
                        : status == DownloadManager.STATUS_SUCCESSFUL ? "completed"
                        : status == DownloadManager.STATUS_FAILED ? "failed" : "queued";
                    sendDownloadState(state, downloaded, total, reason);
                    lastStatus = status;
                    lastProgress = progress;
                }
                if (status == DownloadManager.STATUS_SUCCESSFUL) return;
                if (status == DownloadManager.STATUS_FAILED) {
                    if (id == updateDownloadId) updateDownloadId = -1;
                    return;
                }
            } catch (Exception error) {
                if (id == updateDownloadId) updateDownloadId = -1;
                sendDownloadState("failed", 0, 0, 0);
                return;
            }
            try { Thread.sleep(500); }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return; }
        }
    }

    private void sendDownloadState(String state, long downloaded, long total, int reason) {
        JSONObject detail = new JSONObject();
        try {
            int progress = total > 0 ? (int) Math.min(100, downloaded * 100 / total) : -1;
            String message = "等待系统开始下载";
            if ("running".equals(state)) message = "正在下载安装包";
            else if ("paused".equals(state)) message = "下载已暂停，等待网络恢复";
            else if ("ready".equals(state)) message = "安装包已下载，点击按钮打开系统安装器";
            else if ("installing".equals(state)) message = "正在打开系统安装器";
            else if ("failed".equals(state)) message = reason > 0 ? "下载失败（错误码 " + reason + "）" : "下载失败，请检查网络后重试";
            detail.put("state", state);
            detail.put("progress", progress);
            detail.put("downloaded", Math.max(0, downloaded));
            detail.put("total", Math.max(0, total));
            detail.put("message", message);
        } catch (Exception ignored) { return; }
        String callback = "window.dispatchEvent(new CustomEvent('api-balance-download',{detail:" + detail + "}))";
        runOnUiThread(() -> { if (webView != null) webView.evaluateJavascript(callback, null); });
    }

    private void installApk(Uri uri) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            pendingInstallUri = uri;
            sendDownloadState("ready", 0, 0, 0);
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            toast("请允许安装未知应用，然后返回继续更新");
            return;
        }
        Intent install = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            installerActive = true;
            sendDownloadState("installing", 0, 0, 0);
            startActivity(install);
        } catch (Exception error) {
            installerActive = false;
            sendDownloadState("failed", 0, 0, 0);
            toast("无法打开系统安装器，请检查系统安装权限");
        }
    }

    private void openExternal(Uri uri) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (Exception error) { toast("没有可打开此链接的应用"); }
    }

    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.evaluateJavascript("window.dispatchEvent(new Event('api-balance-resume'))", null);
        if (pendingInstallUri != null && (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getPackageManager().canRequestPackageInstalls())) {
            Uri uri = pendingInstallUri;
            pendingInstallUri = null;
            installApk(uri);
        } else if (pendingInstallUri != null) {
            sendDownloadState("ready", 0, 0, 0);
        } else if (installerActive) {
            installerActive = false;
            sendDownloadState("ready", 0, 0, 0);
        }
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        try { unregisterReceiver(downloadReceiver); } catch (Exception ignored) {}
        network.shutdownNow();
        webView.removeJavascriptInterface("AndroidApp");
        webView.destroy();
        webView = null;
        super.onDestroy();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        if (requestCode == EXPORT_FILE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingExport != null) {
                try (OutputStream stream = getContentResolver().openOutputStream(data.getData())) {
                    if (stream == null) throw new IllegalStateException("无法创建文件");
                    stream.write(pendingExport.getBytes(StandardCharsets.UTF_8));
                    toast("配置已导出");
                } catch (Exception error) { toast("配置导出失败"); }
            }
            pendingExport = null;
        }
    }

    public final class AndroidBridge {
        @JavascriptInterface public boolean isStandalone() { return true; }
        @JavascriptInterface public String getVersionName() { return MainActivity.this.getVersionName(); }
        @JavascriptInterface public String loadState() { return MainActivity.this.loadState(); }
        @JavascriptInterface public void saveState(String value) { MainActivity.this.saveState(value); }
        @JavascriptInterface public boolean verifyLicense(String code, String installId) { return MainActivity.this.verifyLicense(code, installId); }
        @JavascriptInterface public void httpRequest(String id, String value) { MainActivity.this.httpRequest(id, value); }
        @JavascriptInterface public void saveExport(String value) { runOnUiThread(() -> MainActivity.this.saveExport(value)); }
        @JavascriptInterface public void downloadUpdate() { runOnUiThread(MainActivity.this::downloadUpdate); }
        @JavascriptInterface public void installDownloadedUpdate() { runOnUiThread(MainActivity.this::installDownloadedUpdate); }
        @JavascriptInterface public boolean copyText(String value) {
            try {
                ClipboardManager clipboard = (ClipboardManager) MainActivity.this.getSystemService(Context.CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(ClipData.newPlainText("API Balance", value == null ? "" : value));
                return true;
            } catch (Exception error) { return false; }
        }
        @JavascriptInterface public void scheduleRefresh(double minutes) { BalanceWorker.schedule(MainActivity.this, Math.round(minutes)); }
    }

    private final class AppChromeClient extends WebChromeClient {
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json");
            try { startActivityForResult(intent, FILE_CHOOSER); }
            catch (Exception error) { fileCallback = null; toast("无法打开文件选择器"); return false; }
            return true;
        }
    }

    private final class AppWebViewClient extends WebViewClient {
        @Override public void onPageFinished(WebView view, String url) {
            view.evaluateJavascript("document.addEventListener('click',function(e){var a=e.target.closest('a[target=\\\"_blank\\\"]');if(a)a.target='_self'},true)", null);
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("file".equalsIgnoreCase(uri.getScheme())) return false;
            openExternal(uri);
            return true;
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) toast("应用页面加载失败，请重新打开");
        }
    }

    private final class AppDownloadListener implements DownloadListener {
        @Override public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long length) {
            if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) openExternal(Uri.parse(url));
            else toast("无法下载此文件");
        }
    }
}
