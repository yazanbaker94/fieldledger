package video.swoop.fieldledger.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class FieldLedgerRepositoryTest {
    @Test
    fun correctionPostingPermissionsPersistenceAndReset() = runBlocking(Dispatchers.IO) {
        val registry = InstrumentationRegistry.getInstrumentation()
        val baseUrl = InstrumentationRegistry.getArguments().getString("fieldLedgerApiUrl")
        assumeTrue("Supply -e fieldLedgerApiUrl for a disposable demo backend.", baseUrl != null)
        val origin = requireNotNull(baseUrl)
        val file = File(registry.targetContext.cacheDir, "repo-${UUID.randomUUID()}.preferences_pb")
        var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        var store = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
        try {
            val first = FieldLedgerRepository(origin, store)
            val start = first.load()
            assertEquals(970_000L, start.project.approvedCents)
            assertEquals(1_000_000L, start.project.budgetCents)
            assertEquals(0L, start.project.pendingCents)
            assertEquals("Maya Chen", start.worker.name)
            assertEquals("Lucas Martin", start.foreman.name)
            assertEquals("Avery Brooks", start.manager.name)

            val day = projectToday().toString()
            val submitted = first.submit(day, 7.0)
            val id = requireNotNull(submitted.affectedCardId)
            val pending = submitted.card(id)
            assertTrue(submitted.belongsToWorker(pending))
            assertEquals(CardStatus.PENDING, pending.status)
            assertEquals(35_000L, submitted.project.pendingCents)
            assertEquals(970_000L, submitted.project.approvedCents)

            val api = FieldLedgerApi(origin)
            val cookie = store.cookie()
            for (role in listOf(Role.WORKER, Role.MANAGER)) {
                val error = assertThrows(FieldLedgerException::class.java) {
                    api.request(
                        "/timecards/$id/decision", cookie, start.workspaceId, role = role,
                        body = JSONObject().put("decision", "approve").put("version", pending.version),
                    )
                }
                assertEquals(403, error.status)
            }

            val note = "Please include the final hour spent on site."
            val sentBack = first.decide(pending, approve = false, reason = note)
            assertEquals(0L, sentBack.project.pendingCents)
            assertEquals(970_000L, sentBack.project.approvedCents)
            val returned = sentBack.card(id)
            assertEquals(note, returned.reason)
            assertEquals(CardStatus.RETURNED, returned.status)

            val revised = first.resubmit(returned, day, 8.0)
            val corrected = revised.card(id)
            assertEquals(CardStatus.PENDING, corrected.status)
            assertEquals(8.0, corrected.hours, 0.0)
            assertEquals(7.0, requireNotNull(corrected.audit.last().previousHours), 0.0)
            assertEquals(40_000L, revised.project.pendingCents)
            assertEquals(970_000L, revised.project.approvedCents)

            val approved = first.decide(corrected, approve = true)
            val posted = approved.card(id)
            assertEquals(CardStatus.APPROVED, posted.status)
            assertEquals(40_000L, posted.costCents)
            assertEquals(970_000L, posted.approvedBeforeCents)
            assertEquals(1_010_000L, approved.project.approvedCents)
            assertEquals(10_000L, approved.project.approvedCents - approved.project.budgetCents)
            assertEquals(0L, approved.project.pendingCents)
            assertEquals(listOf("submitted", "returned", "resubmitted", "approved"), posted.audit.map { it.action })

            // Replaying the exact original decision is safe even after its first response.
            val replay = first.decide(corrected, approve = true)
            assertEquals(1_010_000L, replay.project.approvedCents)
            assertEquals(1, replay.card(id).audit.count { it.action == "approved" })

            closeStore(scope)
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            store = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
            val reopened = FieldLedgerRepository(origin, store)
            val restored = reopened.load()
            assertEquals(start.workspaceId, restored.workspaceId)
            assertEquals(1_010_000L, restored.project.approvedCents)
            assertEquals(posted, restored.card(id))
            assertNull(reopened.pendingSubmission())

            val reset = reopened.reset()
            assertNotEquals(start.workspaceId, reset.workspaceId)
            assertEquals(970_000L, reset.project.approvedCents)
            assertFalse(reset.timecards.any { it.id == id })
            assertEquals(reset.workspaceId, reopened.load().workspaceId)

            // Simulate an interrupted process with a durable request ID and a committed server response.
            val attemptId = UUID.randomUUID().toString()
            val key = androidx.datastore.preferences.core.stringPreferencesKey("workspace:${api.origin}")
            store.edit { state ->
                val saved = JSONObject(requireNotNull(state[key]))
                saved.put("attempt", JSONObject().put("requestId", attemptId).put("workDate", day).put("hours", 1))
                state[key] = saved.toString()
            }
            val committed = api.request(
                "/timecards", store.cookie(), reset.workspaceId, role = Role.WORKER,
                body = JSONObject().put("requestId", attemptId).put("workDate", day).put("hours", 1),
            ).data
            val reconciled = reopened.load()
            assertEquals(committed.affectedCardId, reconciled.affectedCardId)
            assertEquals(5_000L, reconciled.project.pendingCents)
            assertNull(reopened.pendingSubmission())
        } finally {
            closeStore(scope)
            file.delete()
        }
        Unit
    }

    private suspend fun closeStore(scope: CoroutineScope) {
        scope.cancel()
        scope.coroutineContext[Job]?.join()
    }

    private fun Workspace.card(id: String) = timecards.single { it.id == id }

    private suspend fun DataStore<Preferences>.cookie(): SessionCookie {
        val stored = JSONObject(data.first().asMap().values.single() as String)
        return SessionCookie(stored.getString("cookieName"), stored.getString("cookieValue"), stored.getLong("expiresAt"))
    }
}
