package video.swoop.fieldledger.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import video.swoop.fieldledger.data.CardStatus
import video.swoop.fieldledger.data.Person
import video.swoop.fieldledger.data.Project
import video.swoop.fieldledger.data.Timecard
import video.swoop.fieldledger.data.Workspace
import video.swoop.fieldledger.data.projectToday

@RunWith(AndroidJUnit4::class)
class FieldInputTest {
    @get:Rule val compose = createComposeRule()

    private val shift = Timecard(
        id = "maya-card",
        workerName = "Maya Chen",
        workerId = "maya",
        workDate = projectToday().toString(),
        hours = 7.0,
        status = CardStatus.PENDING,
        submittedAt = "2025-05-12T13:00:00Z",
        version = 1,
        rateCents = 5_000,
        costCents = 35_000,
    )
    private val workspace = Workspace(
        workspaceId = "native-test",
        project = Project("riverside", "Riverside Road Renewal", "RIV-024", "Ottawa, ON", 1_000_000, 970_000, 35_000),
        worker = Person("Maya Chen", "maya"),
        foreman = Person("Lucas Martin"),
        manager = Person("Avery Brooks"),
        timecards = listOf(shift, shift.copy(id = "crew-card", workerName = "Joel Santos", workerId = "joel")),
    )

    @Test
    fun workerUsesNativeDatePickerAndRejectsOutOfRangeHours() {
        var submittedHours: Double? = null
        compose.setContent {
            FieldTheme {
                WorkerScreen(
                    workspace, false, null, false,
                    onOpen = {}, onEdit = {},
                    onSubmit = { _, hours -> submittedHours = hours },
                    onResubmit = { _, _, _ -> },
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("worker-date").performScrollTo().performClick()
        compose.onNodeWithText("Use date").assertIsEnabled().performClick()

        val hours = compose.onNodeWithTag("worker-hours")
        val submit = compose.onNodeWithTag("worker-submit")
        hours.performScrollTo().performTextClearance()
        hours.performTextInput("25")
        submit.assertIsNotEnabled()
        compose.onNodeWithTag("worker-example").performScrollTo().performClick()
        submit.performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(7.0, submittedHours) }
        compose.onNodeWithText("1 on record").assertExists()
        compose.onNodeWithTag("worker-card-crew-card").assertDoesNotExist()
        compose.onNodeWithTag("foreman-approve").assertDoesNotExist()
    }

    @Test
    fun foremanRequiresVisibleNoteAndReturnsTheSelectedRevision() {
        var submitted: Triple<Timecard, Boolean, String?>? = null
        compose.setContent {
            FieldTheme {
                ForemanScreen(
                    workspace, false, shift.id, onOpen = {},
                    onDecide = { card, approve, note -> submitted = Triple(card, approve, note) },
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("foreman-return").performScrollTo().performClick()
        val send = compose.onNodeWithTag("foreman-send")
        send.assertIsNotEnabled()
        compose.onNodeWithTag("foreman-note").performScrollTo().performTextInput("\u200B")
        send.assertIsNotEnabled()
        compose.onNodeWithTag("foreman-example").performScrollTo().performClick()
        send.performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(
                Triple(shift, false, "Please include the final hour spent on site. The shift should total 8 hours."),
                submitted,
            )
        }
    }
}
