package video.swoop.fieldledger.ui

import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Rule
import org.junit.Test
import video.swoop.fieldledger.data.CardStatus
import video.swoop.fieldledger.data.Person
import video.swoop.fieldledger.data.Project
import video.swoop.fieldledger.data.Timecard
import video.swoop.fieldledger.data.Workspace
import video.swoop.fieldledger.data.formatCad

class ManagerScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun historicalPostingDoesNotReplaceCurrentProjectTotal() {
        val historical = sampleCard(CardStatus.APPROVED, 10_000, 0)
        show(historical)
        compose.onNodeWithTag("manager-total").assertTextEquals(formatCad(1_010_000))
        compose.onNodeWithTag("manager-variance").assertTextEquals("${formatCad(10_000)} over budget")
        compose.onNodeWithTag("manager-trail").assertContentDescriptionEquals(
            "Approved posting from ${formatCad(0)} to ${formatCad(10_000)}. Budget ${formatCad(1_000_000)}.",
        )
    }

    @Test
    fun pendingCostIsAProjectionAndDoesNotChangeApprovedLabour() {
        val pending = sampleCard(CardStatus.PENDING, 10_000, null)
        show(pending)
        compose.onNodeWithTag("manager-total").assertTextEquals(formatCad(1_010_000))
        compose.onNodeWithTag("manager-trail").assertContentDescriptionEquals(
            "Estimated posting from ${formatCad(1_010_000)} to ${formatCad(1_020_000)}. Budget ${formatCad(1_000_000)}.",
        )
    }

    private fun show(card: Timecard) {
        val workspace = Workspace(
            workspaceId = "manager-test",
            project = Project("riverside", "Riverside Road Renewal", "RIV-024", "Ottawa, ON", 1_000_000, 1_010_000, 10_000),
            worker = Person("Maya Chen"),
            foreman = Person("Lucas Martin"),
            manager = Person("Avery Brooks"),
            timecards = listOf(card),
        )
        compose.setContent {
            FieldTheme {
                ManagerScreen(
                    workspace = workspace,
                    cardId = card.id,
                    posting = null,
                    onOpen = {},
                    onBack = {},
                    onPostingPlayed = {},
                )
            }
        }
    }

    private fun sampleCard(status: CardStatus, cost: Long, before: Long?) = Timecard(
        id = "source-card",
        workerName = "Maya Chen",
        workDate = "2026-10-15",
        hours = 2.0,
        status = status,
        submittedAt = "2026-10-15T16:00:00Z",
        costCents = cost,
        rateCents = 5_000,
        approvedBeforeCents = before,
        version = 2,
    )
}
