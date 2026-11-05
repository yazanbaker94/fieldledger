package video.swoop.fieldledger

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import video.swoop.fieldledger.data.ApprovalPosting
import video.swoop.fieldledger.data.CardStatus
import video.swoop.fieldledger.data.FieldLedgerRepository
import video.swoop.fieldledger.data.PendingSubmission
import video.swoop.fieldledger.data.Role
import video.swoop.fieldledger.data.Timecard
import video.swoop.fieldledger.data.Workspace

data class Handoff(val role: Role, val cardId: String, val edit: Boolean = false)

data class WorkspaceUiState(
    val workspace: Workspace? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val handoff: Handoff? = null,
    val posting: ApprovalPosting? = null,
    val pending: PendingSubmission? = null,
    val resetCount: Int = 0,
)

class FieldLedgerViewModel(private val repository: FieldLedgerRepository) : ViewModel() {
    private val mutableState = MutableStateFlow(WorkspaceUiState())
    val state = mutableState.asStateFlow()
    private var lastRead = Long.MIN_VALUE

    init { refresh() }

    fun resumed() {
        if (lastRead == Long.MIN_VALUE || SystemClock.elapsedRealtime() - lastRead > 2_000) refresh()
    }

    fun refresh() = perform {
        val saved = repository.load()
        val recovered = saved.affectedCardId?.let { Handoff(Role.FOREMAN, it) }
        apply(saved, if (recovered == null) null else "Saved timecard recovered.", recovered)
    }

    fun submit(date: String, hours: Double) = perform {
        val saved = repository.submit(date, hours)
        apply(saved, "Timecard submitted.", saved.affectedCardId?.let { Handoff(Role.FOREMAN, it) })
    }

    fun resubmit(card: Timecard, date: String, hours: Double) = perform {
        val saved = repository.resubmit(card, date, hours)
        apply(saved, "Correction resubmitted.", Handoff(Role.FOREMAN, card.id))
    }

    fun decide(card: Timecard, approve: Boolean, reason: String?) = perform {
        val saved = repository.decide(card, approve, reason)
        val updated = saved.timecards.find { it.id == card.id }
        if (approve && updated?.status == CardStatus.APPROVED) {
            val before = updated.approvedBeforeCents
            val cost = updated.costCents
            val after = if (before != null && cost != null) before + cost else null
            val posting = if (before != null && cost != null && cost > 0 && after == saved.project.approvedCents) {
                ApprovalPosting(card.id, before, saved.project.approvedCents)
            } else null
            apply(saved, "Approved and posted to the ledger.", Handoff(Role.MANAGER, card.id), posting)
        } else if (!approve && updated?.status == CardStatus.RETURNED) {
            apply(saved, "Timecard returned for correction.", Handoff(Role.WORKER, card.id, edit = true))
        } else {
            apply(saved, "Review saved. This timecard has a newer revision.")
        }
    }

    fun reset() = perform {
        apply(repository.reset(), "A fresh demo is ready.")
        mutableState.update { it.copy(resetCount = it.resetCount + 1) }
    }

    fun checkPending() = perform {
        val saved = repository.checkPendingSubmission()
        if (saved == null) {
            mutableState.update { it.copy(message = "No saved receipt yet. Retry the original date and hours or discard the attempt.") }
        } else {
            apply(saved, "Saved timecard recovered.", saved.affectedCardId?.let { Handoff(Role.FOREMAN, it) })
        }
    }

    fun discardPending() = perform {
        val saved = repository.discardPendingSubmission()
        val handoff = saved.affectedCardId?.let { Handoff(Role.FOREMAN, it) }
        apply(saved, if (handoff == null) "Unsaved attempt discarded." else "The timecard was already saved.", handoff)
    }

    fun dismiss(keepPosting: Boolean = false) {
        mutableState.update { it.copy(error = null, message = null, handoff = null, posting = it.posting.takeIf { keepPosting }) }
    }

    fun postingPlayed() { mutableState.update { it.copy(posting = null) } }

    private fun apply(
        workspace: Workspace,
        message: String? = null,
        handoff: Handoff? = null,
        posting: ApprovalPosting? = null,
    ) {
        lastRead = SystemClock.elapsedRealtime()
        mutableState.update { previous ->
            if (message == null && previous.workspace?.workspaceId == workspace.workspaceId) {
                previous.copy(workspace = workspace)
            } else {
                previous.copy(workspace = workspace, message = message, handoff = handoff, posting = posting)
            }
        }
    }

    private fun perform(action: suspend () -> Unit) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                action()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                mutableState.update { it.copy(error = error.message ?: "FieldLedger couldn’t complete the request. Try again.") }
            } finally {
                val pending = try {
                    repository.pendingSubmission()
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    mutableState.value.pending
                }
                mutableState.update { it.copy(busy = false, pending = pending) }
            }
        }
    }
}
