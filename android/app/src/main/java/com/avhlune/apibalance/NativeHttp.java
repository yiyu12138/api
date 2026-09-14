package com.avhlune.apibalance;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

final class NativeHttp {
    private static final int MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

    private NativeHttp() {}

    static JSONObject request(JSONObject input) {
        JSONObject output = new JSONObject();
        HttpURLConnection connection = null;
        try {
            URL url = new URL(input.getString("url"));
            if (!("http".equalsIgnoreCase(url.getProtocol()) || "https".equalsIgnoreCase(url.getProtocol()))) throw new IllegalArgumentException("仅支持 HTTP 或 HTTPS 地址");
            connection = (HttpURLConnection) url.openConnection();
            int timeout = Math.max(1000, Math.min(60000, input.optInt("timeout", 12000)));
            connection.setConnectTimeout(timeout);
            connection.setReadTimeout(timeout);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestMethod(input.optString("method", "GET"));
            JSONObject headers = input.optJSONObject("headers");
            if (headers != null) {
                Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    if (!"host".equalsIgnoreCase(name) && !"content-length".equalsIgnoreCase(name)) connection.setRequestProperty(name, headers.optString(name));
                }
            }
            String body = input.optString("body", "");
            if (!body.isEmpty()) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 1024 * 1024) throw new IllegalArgumentException("请求内容过大");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream stream = connection.getOutputStream()) { stream.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = stream == null ? "" : readLimited(stream);
            output.put("status", status);
            output.put("ok", status >= 200 && status < 300);
            output.put("text", text.length() > 300 ? text.substring(0, 300) : text);
            if (!text.isEmpty()) {
                try { output.put("json", new JSONTokener(text).nextValue()); }
                catch (Exception ignored) { output.put("json", JSONObject.NULL); }
            }
        } catch (Exception error) {
            try { output.put("error", error.getMessage() == null ? "网络请求失败" : error.getMessage()); }
            catch (Exception ignored) { }
        } finally {
            if (connection != null) connection.disconnect();
        }
        return output;
    }

    private static String readLimited(InputStream stream) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalArgumentException("接口响应超过 10 MB");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
