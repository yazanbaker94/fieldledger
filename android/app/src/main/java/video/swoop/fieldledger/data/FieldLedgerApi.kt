package video.swoop.fieldledger.data

import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

internal data class SessionCookie(val name: String, val value: String, val expiresAt: Long) {
    val header: String get() = "$name=$value"
}

internal data class ApiResponse(val data: Workspace, val sessionCookie: SessionCookie?)

internal class FieldLedgerApi(baseUrl: String) {
    val origin = normalizedOrigin(baseUrl)

    fun request(
        path: String,
        session: SessionCookie? = null,
        workspaceId: String? = null,
        open: Boolean = false,
        role: Role? = null,
        idempotencyKey: String? = null,
        body: JSONObject? = null,
    ): ApiResponse {
        val connection = URI("$origin/api$path").toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = if (body == null) "GET" else "POST"
            connection.connectTimeout = 8_000
            connection.readTimeout = 12_000
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            session?.let { connection.setRequestProperty("Cookie", it.header) }
            workspaceId?.let { connection.setRequestProperty("X-Demo-Workspace", it) }
            role?.let { connection.setRequestProperty("X-Demo-Role", it.apiValue) }
            idempotencyKey?.let { connection.setRequestProperty("Idempotency-Key", it) }
            if (open) connection.setRequestProperty("X-Demo-Open", "1")
            if (body != null) {
                val payload = body.toString().toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                connection.setFixedLengthStreamingMode(payload.size)
                connection.outputStream.use { it.write(payload) }
            }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching { JSONObject(raw) }.getOrNull()
                val message = detail?.stringOrNull("message") ?: "The demo service returned an error. Try again."
                throw FieldLedgerException(message, status, detail?.stringOrNull("code"))
            }
            val cookie = connection.headerFields.entries
                .filter { it.key.equals("Set-Cookie", ignoreCase = true) }
                .flatMap { it.value }
                .firstNotNullOfOrNull { sessionCookie(it, origin.startsWith("https://")) }
            return ApiResponse(JSONObject(raw).toWorkspace(), cookie)
        } catch (error: SocketTimeoutException) {
            throw FieldLedgerException("The connection timed out. Check the workspace and try again.", cause = error)
        } catch (error: IOException) {
            throw FieldLedgerException("Couldn’t reach FieldLedger. Check your connection and try again.", cause = error)
        } catch (error: JSONException) {
            throw FieldLedgerException("FieldLedger returned an unreadable workspace. Try refreshing.", cause = error)
        } catch (error: IllegalArgumentException) {
            throw FieldLedgerException("FieldLedger returned an invalid workspace. Try refreshing.", cause = error)
        } finally {
            connection.disconnect()
        }
    }
}

internal val uuidText = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)

internal fun normalizedOrigin(baseUrl: String): String {
    val uri = URI(baseUrl.trim())
    val scheme = uri.scheme?.lowercase(Locale.ROOT)
    val host = uri.host?.lowercase(Locale.ROOT)
    require(host != null && uri.userInfo == null && uri.query == null && uri.fragment == null &&
        uri.path.orEmpty() in listOf("", "/") &&
        (scheme == "https" || (scheme == "http" && host in setOf("10.0.2.2", "127.0.0.1", "localhost")))) {
        "Use an HTTPS API origin or a local Android development endpoint."
    }
    return URI(scheme, null, host, uri.port, null, null, null).toASCIIString()
}

internal fun sessionCookie(header: String, secure: Boolean): SessionCookie? {
    val parts = header.split(';').map(String::trim)
    val name = parts.first().substringBefore('=')
    val expected = if (secure) "__Host-fieldledger" else "fieldledger"
    val value = parts.first().substringAfter('=', "")
    if (name != expected || !uuidText.matches(value)) return null
    val date = parts.firstOrNull { it.substringBefore('=').equals("Expires", ignoreCase = true) }
        ?.substringAfter('=', "")
    val expiry = runCatching {
        ZonedDateTime.parse(date ?: return null, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
    }.getOrNull() ?: return null
    return SessionCookie(name, value, expiry)
}

internal fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else getString(key)
internal fun JSONObject.longOrNull(key: String): Long? = if (isNull(key)) null else getLong(key)
internal fun JSONObject.doubleOrNull(key: String): Double? = if (isNull(key)) null else getDouble(key)
internal fun JSONObject.intOrNull(key: String): Int? = if (isNull(key)) null else getInt(key)

private fun JSONObject.toPerson() = Person(name = getString("name"), id = stringOrNull("id"))

private fun JSONObject.toProject() = Project(
    id = getString("id"),
    name = getString("name"),
    code = getString("code"),
    location = getString("location"),
    budgetCents = getLong("budgetCents"),
    approvedCents = getLong("approvedCents"),
    pendingCents = getLong("pendingCents"),
)

private fun JSONObject.toAuditEvent() = AuditEvent(
    action = getString("action"),
    actor = getString("actor"),
    at = getString("at"),
    note = stringOrNull("note"),
    previousWorkDate = stringOrNull("previousWorkDate"),
    previousHours = doubleOrNull("previousHours"),
    workDate = stringOrNull("workDate"),
    hours = doubleOrNull("hours"),
)

private fun JSONObject.toTimecard() = Timecard(
    id = getString("id"),
    workerId = stringOrNull("workerId"),
    workerName = getString("workerName"),
    workDate = getString("workDate"),
    hours = getDouble("hours"),
    status = CardStatus.valueOf(getString("status").uppercase(Locale.ROOT)),
    submittedAt = getString("submittedAt"),
    decisionAt = stringOrNull("decisionAt"),
    decisionBy = stringOrNull("decisionBy"),
    reason = stringOrNull("reason"),
    costCents = longOrNull("costCents"),
    rateCents = longOrNull("rateCents"),
    approvedBeforeCents = longOrNull("approvedBeforeCents"),
    version = getInt("version"),
    canReturn = optBoolean("canReturn", true),
    audit = getJSONArray("audit").let { entries -> List(entries.length()) { entries.getJSONObject(it).toAuditEvent() } },
)

internal fun JSONObject.toWorkspace() = Workspace(
    workspaceId = getString("workspaceId"),
    project = getJSONObject("project").toProject(),
    worker = getJSONObject("worker").toPerson(),
    foreman = getJSONObject("foreman").toPerson(),
    manager = getJSONObject("manager").toPerson(),
    timecards = getJSONArray("timecards").let { cards -> List(cards.length()) { cards.getJSONObject(it).toTimecard() } },
    affectedCardId = stringOrNull("affectedCardId"),
)
