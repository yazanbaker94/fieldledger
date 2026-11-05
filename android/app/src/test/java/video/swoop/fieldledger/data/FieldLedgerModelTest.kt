package video.swoop.fieldledger.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class FieldLedgerModelTest {
    @Test
    fun currencyUsesExactCentsAndHoursMatchServerRange() {
        assertEquals("$9,700", formatCad(970_000))
        assertEquals("$10,100.50", formatCad(1_010_050))
        assertEquals("8.25", formatHours(8.25))
        listOf(0.01, 7.0, 8.25, 24.0).forEach { assertTrue(isValidHours(it)) }
        listOf(Double.NaN, Double.POSITIVE_INFINITY, 0.0, 0.001, 8.001, 24.01).forEach {
            assertFalse(isValidHours(it))
        }
    }

    @Test
    fun returnNotesRequireVisibleValidText() {
        assertTrue(isValidReturnReason("Please include the final hour. 📝"))
        assertFalse(isValidReturnReason(" \n \t "))
        assertFalse(isValidReturnReason("\u200b\ufe0f"))
        assertFalse(isValidReturnReason("Note\u0000"))
        assertFalse(isValidReturnReason("x".repeat(501)))
    }

    @Test
    fun apiOriginAndCookieAreRestrictedToTheIntendedService() {
        assertEquals("https://fieldledger.swoop.video", normalizedOrigin("HTTPS://FIELDLEDGER.SWOOP.VIDEO/"))
        assertEquals("http://10.0.2.2:3000", normalizedOrigin("http://10.0.2.2:3000"))
        assertThrows(IllegalArgumentException::class.java) { normalizedOrigin("http://fieldledger.swoop.video") }
        assertThrows(IllegalArgumentException::class.java) { normalizedOrigin("https://host/api") }

        val token = "3f8eaf9f-ef63-440a-8675-678b7d97603a"
        val expires = "Expires=Thu, 05 Nov 2026 18:30:00 GMT"
        val cookie = sessionCookie("__Host-fieldledger=$token; Path=/; $expires; HttpOnly; Secure; SameSite=Lax", secure = true)
        assertEquals("__Host-fieldledger=$token", cookie?.header)
        assertEquals(Instant.parse("2026-11-05T18:30:00Z").toEpochMilli(), cookie?.expiresAt)
        assertNull(sessionCookie("__Host-fieldledger-retired-$token=1; Max-Age=120", secure = true))
        assertNull(sessionCookie("fieldledger=$token; $expires", secure = true))
    }

    @Test
    fun savedReviewRequiresMatchingActorActionAndRevision() {
        val pending = Timecard(
            id = "sample-card", workerName = "Maya Chen", workDate = "2026-11-05", hours = 7.0,
            status = CardStatus.PENDING, submittedAt = "", version = 1, workerId = "maya",
        )
        val returned = pending.copy(
            status = CardStatus.RETURNED, version = 2, decisionBy = "Lucas Martin", reason = "Include one more hour.",
        )
        val workspace = Workspace(
            workspaceId = "sample-workspace",
            project = Project("riverside", "Riverside Road Renewal", "RIV-024", "Ottawa", 1_000_000, 970_000, 0),
            worker = Person("Maya Chen", "maya"), foreman = Person("Lucas Martin"), manager = Person("Avery Brooks"),
            timecards = listOf(returned),
        )
        assertTrue(workspace.containsDecision(pending, approve = false, note = returned.reason))
        assertFalse(workspace.containsDecision(pending, approve = true, note = null))
        assertFalse(workspace.containsDecision(pending, approve = false, note = "Different note."))
        assertTrue(workspace.belongsToWorker(pending))
        assertFalse(workspace.belongsToWorker(pending.copy(workerId = "another-worker")))

        val corrected = pending.copy(version = 3, audit = listOf(
            AuditEvent("submitted", "Maya Chen", ""),
            AuditEvent("returned", "Lucas Martin", "", note = returned.reason),
            AuditEvent("resubmitted", "Maya Chen", ""),
        ))
        assertTrue(workspace.copy(timecards = listOf(corrected)).containsDecision(pending, false, returned.reason))
        assertFalse(workspace.copy(timecards = listOf(corrected.copy(audit = corrected.audit.takeLast(2))))
            .containsDecision(pending, false, returned.reason))
    }
}
