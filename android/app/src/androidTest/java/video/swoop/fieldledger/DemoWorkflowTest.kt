package video.swoop.fieldledger

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class DemoWorkflowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun correctedShiftPostsOnceAndRemainsInspectable() {
        assumeTrue(BuildConfig.API_ORIGIN.startsWith("http://10.0.2.2:"))
        await("worker-submit")
        reset()
        capture("01-worker")

        scrollAndClick("worker-example")
        scrollAndClick("worker-submit")
        click("handoff-foreman")
        await("foreman-return")
        capture("02-foreman-review")
        scrollAndClick("foreman-return")
        scrollAndClick("foreman-example")
        scrollAndClick("foreman-send")

        click("handoff-worker")
        await("worker-correct-example")
        capture("03-worker-correction")
        scrollAndClick("worker-correct-example")
        scrollAndClick("worker-resubmit")
        click("handoff-foreman")
        scrollAndClick("foreman-approve")
        click("handoff-manager")

        val posted = hasTestTag("manager-total") and hasText("\$10,100", substring = true)
        compose.waitUntil(15_000) { compose.onAllNodes(posted).fetchSemanticsNodes().isNotEmpty() }
        scrollTo("manager-scroll", "manager-trail")
        compose.onNodeWithTag("manager-trail").assertIsDisplayed()
        capture("04-manager-posting")
        scrollTo("manager-scroll", "manager-source")
        capture("05-manager-source")

        compose.activityRule.scenario.recreate()
        scrollTo("manager-scroll", "manager-total")
        compose.waitUntil(15_000) { compose.onAllNodes(posted).fetchSemanticsNodes().isNotEmpty() }
        scrollTo("manager-scroll", "manager-source")

        click("role-manager")
        await("manager-ledger-screen")
        compose.waitUntil(15_000) {
            compose.onAllNodes(hasTestTag("manager-posting-screen")).fetchSemanticsNodes().isEmpty()
        }
        scrollTo("manager-scroll", "manager-filter-all")
        compose.onNodeWithTag("manager-filter-all").performClick()
        capture("06-manager-ledger")
        reset()
        click("role-manager")
        scrollTo("manager-scroll", "manager-total")
        val opening = hasTestTag("manager-total") and hasText("\$9,700", substring = true)
        compose.waitUntil(15_000) { compose.onAllNodes(opening).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun reset() {
        click("workspace-options")
        compose.waitUntil(15_000) {
            compose.onAllNodes(hasText("Reset demo") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Reset demo").performClick()
        click("confirm-reset")
        compose.waitUntil(15_000) {
            compose.onAllNodes(hasText("A fresh demo is ready.")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Dismiss").performClick()
        await("worker-submit")
    }

    private fun await(tag: String) {
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun click(tag: String) {
        awaitEnabled(tag)
        compose.onNodeWithTag(tag).performClick()
    }

    private fun scrollAndClick(tag: String) {
        awaitEnabled(tag)
        compose.onNodeWithTag(tag).performScrollTo().performClick()
    }

    private fun awaitEnabled(tag: String) {
        compose.waitUntil(15_000) {
            compose.onAllNodes(hasTestTag(tag) and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun scrollTo(container: String, tag: String) {
        await(container)
        compose.onNodeWithTag(container).performScrollToNode(hasTestTag(tag))
    }

    private fun capture(name: String) {
        if (InstrumentationRegistry.getArguments().getString("fieldLedgerScreenshots") != "true") return
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        SystemClock.sleep(350)
        instrumentation.waitForIdleSync()
        val directory = requireNotNull(instrumentation.targetContext.getExternalFilesDir("captures"))
        val screenshot = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        screenshot.recycle()
    }
}
