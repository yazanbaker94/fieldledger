package video.swoop.fieldledger.data

import java.math.BigDecimal
import java.text.NumberFormat
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

enum class Role(val apiValue: String, val label: String) {
    WORKER("worker", "Worker"),
    FOREMAN("foreman", "Foreman"),
    MANAGER("manager", "Manager"),
}

enum class CardStatus(val label: String) {
    PENDING("Pending"),
    RETURNED("Returned"),
    APPROVED("Approved"),
}

data class Person(val name: String, val id: String? = null)

data class Project(
    val id: String,
    val name: String,
    val code: String,
    val location: String,
    val budgetCents: Long,
    val approvedCents: Long,
    val pendingCents: Long,
)

data class AuditEvent(
    val action: String,
    val actor: String,
    val at: String,
    val note: String? = null,
    val previousWorkDate: String? = null,
    val previousHours: Double? = null,
    val workDate: String? = null,
    val hours: Double? = null,
)

data class Timecard(
    val id: String,
    val workerName: String,
    val workDate: String,
    val hours: Double,
    val status: CardStatus,
    val submittedAt: String,
    val decisionAt: String? = null,
    val decisionBy: String? = null,
    val reason: String? = null,
    val costCents: Long? = null,
    val rateCents: Long? = null,
    val approvedBeforeCents: Long? = null,
    val version: Int,
    val canReturn: Boolean = true,
    val audit: List<AuditEvent> = emptyList(),
    val workerId: String? = null,
)

data class Workspace(
    val workspaceId: String,
    val project: Project,
    val worker: Person,
    val foreman: Person,
    val manager: Person,
    val timecards: List<Timecard>,
    val affectedCardId: String? = null,
) {
    fun belongsToWorker(card: Timecard): Boolean =
        if (worker.id != null && card.workerId != null) worker.id == card.workerId
        else worker.name == card.workerName
}

data class PendingSubmission(
    val workDate: String,
    val hours: Double,
    val cardId: String?,
    val version: Int?,
)

data class ApprovalPosting(val cardId: String, val beforeCents: Long, val afterCents: Long)

internal fun Workspace.containsDecision(original: Timecard, approve: Boolean, note: String?): Boolean {
    val card = timecards.firstOrNull { it.id == original.id } ?: return false
    val status = if (approve) CardStatus.APPROVED else CardStatus.RETURNED
    if (card.version == original.version + 1 && card.status == status &&
        card.decisionBy == foreman.name && card.reason == note) return true
    val event = card.audit.getOrNull(original.version) ?: return false
    val action = if (approve) "approved" else "returned"
    return card.version > original.version && card.audit.size == card.version &&
        event.action == action && event.actor == foreman.name && event.note == note
}

class FieldLedgerException(
    override val message: String,
    val status: Int? = null,
    val code: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

private val projectTimeZone = ZoneId.of("America/Toronto")

fun projectToday(): LocalDate = LocalDate.now(projectTimeZone)

fun formatCad(cents: Long): String = NumberFormat.getCurrencyInstance(Locale.CANADA).apply {
    if (cents % 100 == 0L) {
        maximumFractionDigits = 0
        minimumFractionDigits = 0
    }
}.format(BigDecimal.valueOf(cents, 2))

fun formatHours(hours: Double): String = NumberFormat.getNumberInstance(Locale.CANADA).apply {
    maximumFractionDigits = 2
    isGroupingUsed = false
}.format(hours)

fun isValidHours(hours: Double): Boolean =
    hours.isFinite() && hours in 0.01..24.0 && BigDecimal.valueOf(hours).stripTrailingZeros().scale() <= 2

fun isValidReturnReason(reason: String): Boolean {
    val trimmed = reason.trim()
    if (trimmed.isEmpty() || trimmed.length > 500) return false
    val points = trimmed.codePoints().toArray()
    if (points.any { it == 0 || it in 0xD800..0xDFFF }) return false
    return points.any {
        !Character.isWhitespace(it) && !Character.isSpaceChar(it) && !Character.isISOControl(it) &&
            !Character.isIdentifierIgnorable(it) && it !in 0xFE00..0xFE0F &&
            it !in 0xE0100..0xE01EF && it !in 0x115F..0x1160 && it !in 0x17B4..0x17B5 &&
            it != 0x034F && it != 0x3164 && it != 0xFFA0
    }
}
