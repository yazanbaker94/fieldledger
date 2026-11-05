package video.swoop.fieldledger.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeParseException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private val Context.demoSessionStore by preferencesDataStore(
    name = "fieldledger_session",
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
)

private data class SubmissionAttempt(val requestId: String, val draft: PendingSubmission)

private data class DemoSession(
    val cookie: SessionCookie,
    val workspaceId: String,
    val attempt: SubmissionAttempt? = null,
)

class FieldLedgerRepository internal constructor(
    baseUrl: String,
    private val storage: DataStore<Preferences>,
) {
    constructor(context: Context, baseUrl: String) : this(baseUrl, context.applicationContext.demoSessionStore)

    private val api = FieldLedgerApi(baseUrl)
    private val sessionKey = stringPreferencesKey("workspace:${api.origin}")
    private val mutex = locks.getOrPut(api.origin) { Mutex() }

    suspend fun load(): Workspace = serialized {
        val session = readSession()
        if (session == null) return@serialized openWorkspace()

        val response = try {
            api.request("/workspace", session.cookie, session.workspaceId)
        } catch (error: FieldLedgerException) {
            if (error.code != "workspace_expired") throw error
            clearSession()
            return@serialized openWorkspace()
        }
        val workspace = response.data
        if (workspace.workspaceId != session.workspaceId) {
            saveSession(session.copy(workspaceId = workspace.workspaceId, attempt = null))
            return@serialized workspace
        }
        session.attempt?.let { attempt ->
            // A process can be interrupted after the server commits but before the response arrives.
            try {
                checkReceipt(session, attempt)?.let { return@serialized it }
            } catch (_: FieldLedgerException) {
                // The current workspace is available even if receipt reconciliation is temporarily unavailable.
            }
        }
        workspace
    }

    suspend fun pendingSubmission(): PendingSubmission? = serialized { readSession()?.attempt?.draft }

    suspend fun checkPendingSubmission(): Workspace? = serialized {
        val session = requireSession()
        val attempt = session.attempt ?: return@serialized null
        checkReceipt(session, attempt)
    }

    suspend fun discardPendingSubmission(): Workspace = serialized {
        val session = requireSession()
        val attempt = session.attempt ?: throw FieldLedgerException("There is no unconfirmed submission.")
        try {
            val result = api.request(
                "/timecards/submissions/${attempt.requestId}/discard", session.cookie, session.workspaceId,
                role = Role.WORKER, body = JSONObject(),
            ).data
            confirmSubmission(session, result)
        } catch (error: FieldLedgerException) {
            // The server may already have a correction receipt, or have fenced the request before the response was lost.
            checkReceipt(session, attempt)?.let { return@serialized it }
            val current = readSession()
            if (current?.workspaceId == session.workspaceId && current.attempt == null) {
                return@serialized api.request("/workspace", session.cookie, session.workspaceId).data
            }
            throw error
        }
    }

    suspend fun submit(workDate: String, hours: Double): Workspace =
        writeSubmission(PendingSubmission(workDate, hours, cardId = null, version = null))

    suspend fun resubmit(card: Timecard, workDate: String, hours: Double): Workspace =
        writeSubmission(PendingSubmission(workDate, hours, checkedId(card.id), card.version))

    suspend fun decide(card: Timecard, approve: Boolean, reason: String? = null): Workspace = serialized {
        val session = requireSession()
        val cardId = checkedId(card.id)
        val note = if (approve) null else {
            reason?.trim()?.takeIf(::isValidReturnReason)
                ?: throw FieldLedgerException("Enter a visible correction note of 1 to 500 characters.")
        }
        val body = JSONObject()
            .put("version", card.version)
            .put("decision", if (approve) "approve" else "return")
        if (note != null) body.put("reason", note)
        try {
            api.request(
                "/timecards/$cardId/decision", session.cookie, session.workspaceId,
                role = Role.FOREMAN, body = body,
            ).data
        } catch (error: FieldLedgerException) {
            if (!error.possiblyCommitted() && !(error.status == 409 && error.code == null)) throw error
            val snapshot = readForRecovery(session)
            if (snapshot?.workspaceId == session.workspaceId && snapshot.containsDecision(card, approve, note)) {
                snapshot.copy(affectedCardId = cardId)
            } else throw error
        }
    }

    suspend fun reset(): Workspace = serialized {
        val session = requireSession()
        val next = try {
            api.request("/reset", session.cookie, session.workspaceId, body = JSONObject()).data
        } catch (error: FieldLedgerException) {
            if (!error.possiblyCommitted() && error.code != "workspace_changed") throw error
            readForRecovery(session)?.takeIf { it.workspaceId != session.workspaceId } ?: throw error
        }
        if (next.workspaceId == session.workspaceId) throw FieldLedgerException("The demo workspace did not reset. Try again.")
        saveSession(session.copy(workspaceId = next.workspaceId, attempt = null))
        next
    }

    private suspend fun writeSubmission(draft: PendingSubmission): Workspace = serialized {
        validateDraft(draft)
        val session = requireSession()
        val previous = session.attempt
        if (previous != null && previous.draft != draft) {
            throw FieldLedgerException("An earlier entry is still unconfirmed. Check it or retry with the same details.", code = "submission_pending")
        }
        val attempt = previous ?: SubmissionAttempt(UUID.randomUUID().toString(), draft)
        if (previous == null) saveSession(session.copy(attempt = attempt))
        val body = JSONObject().put("workDate", draft.workDate).put("hours", draft.hours)
        val path: String
        if (draft.cardId == null) {
            path = "/timecards"
            body.put("requestId", attempt.requestId)
        } else {
            path = "/timecards/${draft.cardId}/resubmit"
            body.put("version", draft.version)
        }
        try {
            val saved = api.request(
                path, session.cookie, session.workspaceId, role = Role.WORKER,
                idempotencyKey = attempt.requestId.takeIf { draft.cardId != null }, body = body,
            ).data
            confirmSubmission(session, saved)
        } catch (error: FieldLedgerException) {
            val ambiguous = error.possiblyCommitted()
            if (ambiguous || previous != null) {
                val recovered = try { checkReceipt(session, attempt) } catch (_: FieldLedgerException) { null }
                if (recovered != null) return@serialized recovered
            }
            if (!ambiguous && previous == null) saveSession(session.copy(attempt = null))
            throw error
        }
    }

    private suspend fun openWorkspace(): Workspace {
        val result = api.request("/workspace", open = true)
        val cookie = result.sessionCookie
            ?: throw FieldLedgerException("FieldLedger did not issue a session. Try again.")
        saveSession(DemoSession(cookie, result.data.workspaceId))
        return result.data
    }

    private suspend fun checkReceipt(session: DemoSession, attempt: SubmissionAttempt): Workspace? {
        val response = try {
            api.request("/timecards/submissions/${attempt.requestId}", session.cookie, session.workspaceId)
        } catch (error: FieldLedgerException) {
            if (error.code == "submission_discarded") {
                saveSession(session.copy(attempt = null))
                return null
            }
            if (error.status == 404) return null
            throw error
        }
        return confirmSubmission(session, response.data)
    }

    private suspend fun confirmSubmission(session: DemoSession, workspace: Workspace): Workspace {
        if (workspace.workspaceId != session.workspaceId) {
            throw FieldLedgerException("The demo workspace changed. Refresh before making changes.", code = "workspace_changed")
        }
        saveSession(session.copy(attempt = null))
        return workspace
    }

    private fun readForRecovery(session: DemoSession): Workspace? = try {
        api.request("/workspace", session.cookie, session.workspaceId).data
    } catch (_: FieldLedgerException) {
        null
    }

    private suspend fun requireSession(): DemoSession = readSession()
        ?: throw FieldLedgerException("The demo session ended. Reload the workspace to continue.", code = "workspace_expired")

    private suspend fun readSession(): DemoSession? {
        val stored = storage.data.first()[sessionKey] ?: return null
        return runCatching { JSONObject(stored).toSession() }.getOrNull()
            ?.takeIf { it.cookie.expiresAt > System.currentTimeMillis() }
    }

    private suspend fun saveSession(session: DemoSession) {
        storage.edit { it[sessionKey] = session.toJson().toString() }
    }

    private suspend fun clearSession() {
        storage.edit { it.remove(sessionKey) }
    }

    private suspend fun <T> serialized(action: suspend () -> T): T =
        withContext(Dispatchers.IO) { mutex.withLock { action() } }

    private companion object {
        val locks = ConcurrentHashMap<String, Mutex>()
    }
}

private fun FieldLedgerException.possiblyCommitted(): Boolean =
    status == null || status >= 500 || status == 408 || status == 429

private fun checkedId(id: String): String {
    if (!uuidText.matches(id)) throw FieldLedgerException("This timecard identifier is invalid.")
    return id
}

private fun validateDraft(draft: PendingSubmission) {
    val date = try { LocalDate.parse(draft.workDate) } catch (_: DateTimeParseException) { null }
    if (date == null || date.isBefore(LocalDate.of(2000, 1, 1)) || date.isAfter(projectToday())) {
        throw FieldLedgerException("Choose a valid work date on or before today.")
    }
    if (!isValidHours(draft.hours)) {
        throw FieldLedgerException("Enter between 0.01 and 24 hours, with at most two decimal places.")
    }
}

private fun DemoSession.toJson(): JSONObject = JSONObject()
    .put("cookieName", cookie.name)
    .put("cookieValue", cookie.value)
    .put("expiresAt", cookie.expiresAt)
    .put("workspaceId", workspaceId)
    .also { saved ->
        attempt?.let { pending ->
            val draft = pending.draft
            saved.put("attempt", JSONObject().put("requestId", pending.requestId)
                .put("workDate", draft.workDate).put("hours", draft.hours)
                .put("cardId", draft.cardId).put("version", draft.version))
        }
    }

private fun JSONObject.toSession(): DemoSession {
    val name = getString("cookieName")
    require(name == "fieldledger" || name == "__Host-fieldledger")
    val cookie = SessionCookie(name, checkedId(getString("cookieValue")), getLong("expiresAt"))
    val attempt = optJSONObject("attempt")?.let { stored ->
        SubmissionAttempt(
            checkedId(stored.getString("requestId")),
            PendingSubmission(stored.getString("workDate"), stored.getDouble("hours"), stored.stringOrNull("cardId"), stored.intOrNull("version")),
        )
    }
    return DemoSession(cookie, checkedId(getString("workspaceId")), attempt)
}
