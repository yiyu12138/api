package com.avhlune.apibalance;

import android.content.Context;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

public final class BalanceWorker extends Worker {
    private static final String WORK_NAME = "api-balance-refresh";

    public BalanceWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context context, long minutes) {
        WorkManager manager = WorkManager.getInstance(context);
        if (minutes <= 0) {
            manager.cancelUniqueWork(WORK_NAME);
            return;
        }
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
            BalanceWorker.class, Math.max(15, minutes), TimeUnit.MINUTES
        ).setConstraints(constraints).build();
        manager.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    @NonNull @Override public Result doWork() {
        String stored = LocalStore.load(getApplicationContext());
        if (stored.isEmpty()) return Result.success();
        try {
            JSONObject config = new JSONObject(stored);
            JSONArray stations = config.optJSONArray("stations");
            if (stations == null) return Result.success();
            for (int i = 0; i < stations.length(); i++) {
                JSONObject station = stations.optJSONObject(i);
                if (station == null || !station.optBoolean("enabled", true) || !"auto".equals(station.optString("queryMode", "auto"))) continue;
                refreshStation(config, station);
            }
            checkNotifications(config, stations);
            return LocalStore.save(getApplicationContext(), config.toString()) ? Result.success() : Result.retry();
        } catch (Exception error) {
            return Result.retry();
        }
    }

    private static void refreshStation(JSONObject config, JSONObject station) throws Exception {
        String preset = station.optString("preset", "relay-auto");
        if ("openai".equals(preset) || "anthropic".equals(preset) || "gemini".equals(preset) || "compatible".equals(preset)) return;
        long started = System.currentTimeMillis();
        try {
            JSONObject value = query(station, config.optInt("timeoutMs", 12000));
            double balance = value.optDouble("balance");
            String currency = value.optString("currency", "USD");
            double fx = config.optJSONObject("fx") == null ? 7.2 : config.optJSONObject("fx").optDouble("rate", 7.2);
            JSONObject last = new JSONObject()
                .put("ok", true).put("at", System.currentTimeMillis()).put("ms", System.currentTimeMillis() - started)
                .put("mode", value.optString("mode", "background")).put("kind", value.optString("kind", "balance"))
                .put("currency", currency).put("balance", balance)
                .put("balanceUsd", "CNY".equals(currency) ? balance / fx : balance)
                .put("balanceAvailable", true).put("stale", false).put("error", JSONObject.NULL);
            copyNumber(value, last, "used");
            copyNumber(value, last, "total");
            copyNumber(value, last, "requests");
            station.put("failCount", 0).put("last", last);
            pushHistory(config, station.optString("id"), last.optDouble("balanceUsd"));
        } catch (Exception error) {
            int failures = station.optInt("failCount", 0) + 1;
            JSONObject last = station.optJSONObject("last");
            if (last == null) last = new JSONObject();
            String message = error.getMessage() == null ? "后台查询失败" : error.getMessage();
            last.put("ok", false).put("at", System.currentTimeMillis()).put("ms", System.currentTimeMillis() - started)
                .put("stale", true).put("error", message).put("failCount", failures);
            station.put("failCount", failures).put("last", last);
        }
    }

    private static JSONObject query(JSONObject station, int timeout) throws Exception {
        String base = station.optString("baseUrl", "").trim();
        String token = station.optString("token", "");
        String preset = station.optString("preset", "relay-auto");
        if (base.isEmpty()) throw new IllegalArgumentException("未填写查询地址");
        if (token.isEmpty() && !"none".equals(station.optString("authMode"))) throw new IllegalArgumentException("未填写密钥");

        String host = new URL(base).getHost().toLowerCase(Locale.ROOT);
        if (host.equals("soleapi.com") || host.equals("www.soleapi.com")) {
            return fromSimple(call(origin(base) + "/v1/usage", "GET", token, "bearer", "key", station, "", timeout), station, "soleapi", "remaining", "used", "total");
        }
        if (host.equals("cf-api.derouter.ai") || host.endsWith(".derouter.ai")) {
            String path = new URL(base).getPath().replaceAll("/+$", "");
            String url = path.equals("/balance") || path.equals("/sub-key/balance") ? base : origin(base) + "/balance";
            return fromSimple(call(url, "GET", token, "bearer", "key", station, "", timeout), station, "derouter", "remaining", "used", "total");
        }

        if ("relay-auto".equals(preset)) {
            JSONObject response = call(join(base, "/api/user/self"), "GET", token, "bearer", "key", station, "", timeout);
            JSONObject data = response.optJSONObject("data");
            if (data == null || !hasNumber(data.opt("quota"))) throw new IllegalArgumentException("中转站余额格式无法识别");
            double divisor = positive(station.optDouble("rawPerUnit", 500000), 500000);
            double balance = number(data.opt("quota")) / divisor;
            JSONObject result = result(balance, station.optString("unitCurrency", "USD"), "new-api");
            if (hasNumber(data.opt("used_quota"))) {
                double used = number(data.opt("used_quota")) / divisor;
                result.put("used", used).put("total", used + balance);
            }
            if (hasNumber(data.opt("request_count"))) result.put("requests", number(data.opt("request_count")));
            return result;
        }

        if ("custom".equals(preset)) {
            String method = "POST".equals(station.optString("requestMethod")) ? "POST" : "GET";
            String body = fill(station.optString("requestBody"), station, token);
            JSONObject response = call(join(base, fill(station.optString("queryPath"), station, token)), method, token,
                station.optString("authMode", "bearer"), station.optString("authQueryParam", "key"), station, body, timeout);
            return fromPaths(response, station, "custom");
        }

        String path;
        String balancePath;
        String currency;
        String subtractPath = "";
        switch (preset) {
            case "deepseek": path = "/user/balance"; balancePath = "balance_infos.0.total_balance"; currency = "CNY"; break;
            case "moonshot": case "moonshot-intl": path = "/v1/users/me/balance"; balancePath = "data.available_balance"; currency = "CNY"; break;
            case "siliconflow": path = "/v1/user/info"; balancePath = "data.totalBalance"; currency = "CNY"; break;
            case "openrouter-credits": path = "/v1/credits"; balancePath = "data.total_credits"; subtractPath = "data.total_usage"; currency = "USD"; break;
            case "openrouter-key": path = "/v1/key"; balancePath = "data.limit_remaining"; currency = "USD"; break;
            default: throw new IllegalArgumentException("该站点没有可用的后台余额接口");
        }
        JSONObject response = call(join(base, station.optString("queryPath", path)), "GET", token, "bearer", "key", station, "", timeout);
        Object raw = at(response, station.optString("quotaPath", balancePath));
        if (!hasNumber(raw)) throw new IllegalArgumentException("取不到余额字段");
        double balance = number(raw);
        if (!subtractPath.isEmpty() && hasNumber(at(response, subtractPath))) balance -= number(at(response, subtractPath));
        return result(balance, currency, preset);
    }

    private static JSONObject fromSimple(JSONObject response, JSONObject station, String mode, String balancePath, String usedPath, String totalPath) throws Exception {
        Object raw = at(response, balancePath);
        if (!hasNumber(raw)) throw new IllegalArgumentException("余额接口返回格式无法识别");
        JSONObject result = result(number(raw), station.optString("unitCurrency", "USD"), mode);
        if (hasNumber(at(response, usedPath))) result.put("used", number(at(response, usedPath)));
        if (hasNumber(at(response, totalPath))) result.put("total", number(at(response, totalPath)));
        return result;
    }

    private static JSONObject fromPaths(JSONObject response, JSONObject station, String mode) throws Exception {
        Object raw = at(response, station.optString("quotaPath"));
        if (!hasNumber(raw)) throw new IllegalArgumentException("取不到自定义余额字段");
        double divisor = positive(station.optDouble("rawPerUnit", 1), 1);
        double balance = number(raw);
        Object subtract = at(response, station.optString("subtractPath"));
        if (hasNumber(subtract)) balance -= number(subtract);
        JSONObject result = result(balance / divisor, station.optString("unitCurrency", "USD"), mode);
        Object used = at(response, station.optString("usedPath"));
        Object total = at(response, station.optString("totalPath"));
        if (hasNumber(used)) result.put("used", number(used) / divisor);
        if (hasNumber(total)) result.put("total", number(total) / divisor);
        return result;
    }

    private static JSONObject call(String url, String method, String token, String auth, String queryName, JSONObject station, String body, int timeout) throws Exception {
        JSONObject headers = new JSONObject().put("Accept", "application/json");
        JSONObject extras = station.optJSONObject("extraHeaders");
        if (extras != null) {
            Iterator<String> names = extras.keys();
            while (names.hasNext()) { String name = names.next(); headers.put(name, fill(extras.optString(name), station, token)); }
        }
        if ("query".equals(auth)) url = Uri.parse(url).buildUpon().appendQueryParameter(queryName, token).build().toString();
        else if ("x-api-key".equals(auth)) headers.put("x-api-key", token);
        else if (!"none".equals(auth)) headers.put("Authorization", "Bearer " + token);
        if (!body.isEmpty()) headers.put("Content-Type", "application/json");
        JSONObject request = new JSONObject().put("url", url).put("method", method).put("headers", headers).put("body", body).put("timeout", timeout);
        JSONObject output = NativeHttp.request(request);
        if (!output.optBoolean("ok")) throw new IllegalArgumentException(output.optString("error", "HTTP " + output.optInt("status")));
        Object json = output.opt("json");
        if (!(json instanceof JSONObject)) throw new IllegalArgumentException("接口没有返回 JSON 对象");
        return (JSONObject) json;
    }

    private static void checkNotifications(JSONObject config, JSONArray stations) throws Exception {
        JSONObject notify = config.optJSONObject("notify");
        JSONObject channels = notify == null ? null : notify.optJSONObject("channels");
        if (channels == null || currentTime().compareTo(notify.optString("pushTime", "09:00")) < 0) return;
        String day = currentDay();
        double globalThreshold = config.optJSONObject("threshold") == null ? 10 : config.optJSONObject("threshold").optDouble("defaultUsd", 10);
        for (int i = 0; i < stations.length(); i++) {
            JSONObject station = stations.optJSONObject(i);
            JSONObject last = station == null ? null : station.optJSONObject("last");
            if (station == null || last == null || !last.optBoolean("ok") || day.equals(station.optString("lastNotifyDay"))) continue;
            double threshold = station.isNull("thresholdUsd") || !station.has("thresholdUsd") ? globalThreshold : station.optDouble("thresholdUsd", globalThreshold);
            double balance = last.optDouble("balanceUsd", Double.NaN);
            if (Double.isNaN(balance) || balance >= threshold) continue;
            String body = station.optString("name", "站点") + " 当前 $" + String.format(Locale.US, "%.2f", balance)
                + "，低于阈值 $" + String.format(Locale.US, "%.2f", threshold);
            if (sendAll(channels, "API Balance 低余额提醒", body)) station.put("lastNotifyDay", day);
        }
    }

    private static boolean sendAll(JSONObject channels, String title, String body) {
        boolean sent = false;
        Iterator<String> names = channels.keys();
        while (names.hasNext()) {
            String type = names.next();
            JSONObject channel = channels.optJSONObject(type);
            if (channel == null || !channel.optBoolean("enabled")) continue;
            try {
                JSONObject request = notificationRequest(type, channel, title, body);
                if (NativeHttp.request(request).optBoolean("ok")) sent = true;
            } catch (Exception ignored) { }
        }
        return sent;
    }

    private static JSONObject notificationRequest(String type, JSONObject channel, String title, String body) throws Exception {
        JSONObject headers = new JSONObject();
        String url;
        String content = "";
        String method = "GET";
        if ("bark".equals(type)) {
            url = channel.optString("url").replaceAll("/+$", "") + "/" + Uri.encode(title) + "/" + Uri.encode(body) + "?group=" + Uri.encode("API余额");
        } else if ("serverChan".equals(type)) {
            url = "https://sctapi.ftqq.com/" + Uri.encode(channel.optString("sendKey")) + ".send";
            method = "POST"; headers.put("Content-Type", "application/x-www-form-urlencoded"); content = "title=" + Uri.encode(title) + "&desp=" + Uri.encode(body);
        } else if ("pushPlus".equals(type)) {
            url = "https://www.pushplus.plus/send"; method = "POST"; headers.put("Content-Type", "application/json");
            content = new JSONObject().put("token", channel.optString("token")).put("title", title).put("content", body).put("template", "txt").toString();
        } else if ("telegram".equals(type)) {
            url = "https://api.telegram.org/bot" + Uri.encode(channel.optString("botToken")) + "/sendMessage"; method = "POST"; headers.put("Content-Type", "application/json");
            content = new JSONObject().put("chat_id", channel.optString("chatId")).put("text", title + "\n" + body).toString();
        } else {
            url = channel.optString("url"); method = "POST"; headers.put("Content-Type", "application/json");
            content = new JSONObject().put("title", title).put("body", body).put("source", "API Balance Android").put("at", new Date().getTime()).toString();
        }
        return new JSONObject().put("url", url).put("method", method).put("headers", headers).put("body", content).put("timeout", 12000);
    }

    private static void pushHistory(JSONObject config, String id, double value) throws Exception {
        if (id.isEmpty() || Double.isNaN(value)) return;
        JSONObject history = config.optJSONObject("history");
        if (history == null) { history = new JSONObject(); config.put("history", history); }
        JSONArray list = history.optJSONArray(id);
        if (list == null) { list = new JSONArray(); history.put(id, list); }
        list.put(new JSONObject().put("t", System.currentTimeMillis()).put("v", value));
        while (list.length() > 240) list.remove(0);
    }

    private static Object at(Object source, String path) {
        if (path == null || path.isEmpty()) return null;
        Object current = source;
        for (String part : path.split("\\.")) {
            if (current instanceof JSONObject) current = ((JSONObject) current).opt(part);
            else if (current instanceof JSONArray) current = ((JSONArray) current).opt(Integer.parseInt(part));
            else return null;
        }
        return current == JSONObject.NULL ? null : current;
    }

    private static String fill(String value, JSONObject station, String token) {
        return value.replace("{{apiKey}}", token).replace("{{accessToken}}", token)
            .replace("{{baseUrl}}", station.optString("baseUrl").replaceAll("/+$", ""))
            .replace("{{userId}}", station.optJSONObject("extraHeaders") == null ? "" : station.optJSONObject("extraHeaders").optString("New-Api-User"));
    }

    private static String join(String base, String path) {
        if (path.matches("(?i)^https?://.*")) return path;
        return base.replaceAll("/+$", "") + (path.startsWith("/") ? path : "/" + path);
    }

    private static String origin(String value) throws Exception {
        URL url = new URL(value);
        int port = url.getPort();
        return url.getProtocol() + "://" + url.getHost() + (port < 0 ? "" : ":" + port);
    }

    private static JSONObject result(double balance, String currency, String mode) throws Exception {
        return new JSONObject().put("balance", balance).put("currency", "CNY".equals(currency) ? "CNY" : "USD").put("mode", mode).put("kind", "balance");
    }

    private static boolean hasNumber(Object value) {
        if (value == null || value == JSONObject.NULL || String.valueOf(value).trim().isEmpty()) return false;
        try { Double.parseDouble(String.valueOf(value).replaceAll("[,\\s$¥￥]", "")); return true; }
        catch (Exception error) { return false; }
    }

    private static double number(Object value) { return Double.parseDouble(String.valueOf(value).replaceAll("[,\\s$¥￥]", "")); }
    private static double positive(double value, double fallback) { return value > 0 ? value : fallback; }
    private static void copyNumber(JSONObject from, JSONObject to, String key) throws Exception { if (hasNumber(from.opt(key))) to.put(key, number(from.opt(key))); }

    private static String currentDay() { return date("yyyy-MM-dd"); }
    private static String currentTime() { return date("HH:mm"); }
    private static String date(String pattern) {
        SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date());
    }
}
