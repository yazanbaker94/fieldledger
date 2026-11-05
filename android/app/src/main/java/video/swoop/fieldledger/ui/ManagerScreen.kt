package video.swoop.fieldledger.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.currentCoroutineContext
import video.swoop.fieldledger.data.ApprovalPosting
import video.swoop.fieldledger.data.CardStatus
import video.swoop.fieldledger.data.Timecard
import video.swoop.fieldledger.data.Workspace
import video.swoop.fieldledger.data.formatCad
import video.swoop.fieldledger.data.formatHours
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val trailCopper = Color(0xFFDFB38B)
private val trailOver = Color(0xFFF0AB90)
private val trailGrid = Color(0xFF667369)
private val rowShape = RoundedCornerShape(8.dp)
private val workDayFormat = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.CANADA)
private val activityFormat = DateTimeFormatter.ofPattern("MMM d · h:mm a", Locale.CANADA)
private val projectZone = ZoneId.of("America/Toronto")

private fun workDay(value: String): String =
    runCatching { LocalDate.parse(value).format(workDayFormat) }.getOrDefault(value)

private fun auditTime(value: String): String =
    runCatching { OffsetDateTime.parse(value).atZoneSameInstant(projectZone).format(activityFormat) }
        .getOrDefault(value)

private fun variance(amount: Long, budget: Long): String = when {
    amount > budget -> "${formatCad(amount - budget)} over budget"
    amount < budget -> "${formatCad(budget - amount)} remaining"
    else -> "At budget"
}

private fun statusColour(status: CardStatus): Color = when (status) {
    CardStatus.APPROVED -> FieldPalette.Approved
    CardStatus.PENDING -> FieldPalette.Copper
    CardStatus.RETURNED -> FieldPalette.Returned
}

private fun reference(card: Timecard): String = card.id.take(8).uppercase(Locale.ROOT)

private data class ManagerTrace(
    val before: Long,
    val after: Long,
    val beforeLabel: String,
    val postingLabel: String,
    val afterLabel: String,
    val forecast: Boolean = false,
)

private fun traceFor(card: Timecard, current: Long): ManagerTrace? {
    val cost = card.costCents ?: return null
    return when (card.status) {
        CardStatus.APPROVED -> card.approvedBeforeCents?.let {
            ManagerTrace(it, it + cost, "Before posting", "Posted", "After posting")
        } ?: ManagerTrace(current - cost, current, "Other approved", "Posted", "Approved labour")
        CardStatus.PENDING ->
            ManagerTrace(current, current + cost, "Current approved", "Estimate", "If approved", forecast = true)
        CardStatus.RETURNED -> null
    }
}

@Composable
fun ManagerScreen(
    workspace: Workspace,
    cardId: String?,
    posting: ApprovalPosting?,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    onPostingPlayed: () -> Unit,
) {
    val selected = workspace.timecards.firstOrNull { it.id == cardId }
    var approvedOnly by rememberSaveable(workspace.workspaceId) { mutableStateOf(true) }
    val ledger = remember(workspace.timecards, approvedOnly) {
        workspace.timecards.filter { !approvedOnly || it.status == CardStatus.APPROVED }
    }
    val project = workspace.project
    val trace = selected?.let { traceFor(it, project.approvedCents) }
    val verifiedPosting = posting?.takeIf {
        selected != null && selected.id == it.cardId && selected.status == CardStatus.APPROVED &&
            selected.approvedBeforeCents == it.beforeCents && trace?.after == it.afterCents &&
            it.afterCents == project.approvedCents && it.afterCents > it.beforeCents
    }
    val fraction = remember(verifiedPosting) { Animatable(if (verifiedPosting == null) 1f else 0f) }
    val postingPlayed by rememberUpdatedState(onPostingPlayed)
    LaunchedEffect(verifiedPosting, posting, selected?.id) {
        if (verifiedPosting != null) {
            val scale = currentCoroutineContext()[MotionDurationScale]?.scaleFactor ?: 1f
            if (scale > 0f) fraction.animateTo(1f, tween(durationMillis = 1320, easing = LinearEasing))
            else fraction.snapTo(1f)
            postingPlayed()
        } else if (posting != null && selected?.id == posting.cardId) {
            postingPlayed()
        }
    }
    Box(
        Modifier.fillMaxSize().testTag(if (cardId == null) "manager-ledger-screen" else "manager-posting-screen"),
        contentAlignment = Alignment.TopCenter,
    ) {
        LazyColumn(
            modifier = Modifier.widthIn(max = 680.dp).fillMaxWidth().testTag("manager-scroll"),
            contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 28.dp),
        ) {
            item(key = "manager-heading") {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 17.dp)) {
                    if (cardId != null) {
                        TextButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 0.dp), modifier = Modifier.testTag("manager-back")) {
                            Text("←  Labour ledger", color = FieldPalette.Copper, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    RegisterLabel(if (cardId == null) "PROJECT REGISTER  /  ${project.code}" else "POSTING REGISTER  /  ${project.code}")
                    Text(
                        if (cardId == null) "Labour budget" else "Cost trace",
                        style = MaterialTheme.typography.headlineLarge,
                        color = FieldPalette.Ink,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        if (cardId == null) "${project.name} · ${workspace.manager.name}" else selected?.workerName ?: project.name,
                        style = MaterialTheme.typography.bodyMedium,
                        color = FieldPalette.Muted,
                    )
                }
            }
            item(key = "position") {
                val progress = fraction.value
                val shown = verifiedPosting?.let {
                    postingFrame(it.beforeCents, it.afterCents, project.budgetCents, progress)
                } ?: project.approvedCents
                FinancialSheet(
                    current = project.approvedCents,
                    shown = shown,
                    budget = project.budgetCents,
                    pending = project.pendingCents,
                    selected = selected,
                    trace = trace,
                    animating = verifiedPosting != null && progress < 1f,
                    inletProgress = if (verifiedPosting != null && progress < .16f) progress / .16f else null,
                )
            }
            if (cardId == null) {
                item(key = "ledger-header") {
                    Column(Modifier.padding(top = 23.dp, bottom = 7.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Text("Labour ledger", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            LedgerFilter("Approved", approvedOnly, "manager-filter-approved") { approvedOnly = true }
                            LedgerFilter("All timecards", !approvedOnly, "manager-filter-all") { approvedOnly = false }
                        }
                        RegisterLabel("${ledger.size} ${if (ledger.size == 1) "RECORD" else "RECORDS"}  /  CAD")
                    }
                }
                if (ledger.isEmpty()) {
                    item(key = "empty-ledger") {
                        Text("No timecards match this filter.", Modifier.padding(vertical = 16.dp), color = FieldPalette.Muted)
                    }
                }
                items(ledger, key = { it.id }) { card ->
                    LedgerRow(card) { onOpen(card.id) }
                }
            } else if (selected != null) {
                item(key = "source") { SourceRecord(selected) }
                item(key = "activity") { PostingActivity(selected) }
            } else {
                item(key = "missing") {
                    Text(
                        "This timecard is unavailable. Return to the ledger to choose another record.",
                        Modifier.padding(vertical = 20.dp),
                        color = FieldPalette.Muted,
                    )
                }
            }
        }
    }
}

@Composable
private fun RegisterLabel(label: String, color: Color = FieldPalette.Copper) {
    Text(
        label,
        style = MaterialTheme.typography.labelMedium.copy(
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = .6.sp,
        ),
        color = color,
    )
}

@Composable
private fun FinancialSheet(
    current: Long,
    shown: Long,
    budget: Long,
    pending: Long,
    selected: Timecard?,
    trace: ManagerTrace?,
    animating: Boolean,
    inletProgress: Float?,
) {
    Surface(shape = rowShape, color = FieldPalette.Forest, contentColor = FieldPalette.LightInk) {
        Column(
            Modifier.fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color(0xFF354238), FieldPalette.Forest)))
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            RegisterLabel("PROJECT POSITION  /  CAD", trailCopper)
            Text("Approved labour", style = MaterialTheme.typography.labelLarge, color = FieldPalette.LightMuted)
            Text(
                formatCad(shown),
                style = MaterialTheme.typography.displaySmall.copy(
                    fontFamily = FontFamily.SansSerif, fontFeatureSettings = "tnum",
                ),
                color = FieldPalette.LightInk,
                modifier = Modifier.testTag("manager-total").let { modifier ->
                    if (animating) modifier.clearAndSetSemantics { contentDescription = "${formatCad(current)} approved labour" }
                    else modifier
                },
            )
            Text(
                variance(shown, budget),
                style = MaterialTheme.typography.titleSmall,
                color = if (shown > budget) trailOver else trailCopper,
                modifier = Modifier.testTag("manager-variance").let { modifier ->
                    if (animating) modifier.clearAndSetSemantics { contentDescription = variance(current, budget) }
                    else modifier
                },
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Metric("Labour budget", formatCad(budget), Modifier.weight(1f))
                Metric("Pending estimate", formatCad(pending), Modifier.weight(1f))
            }
            HorizontalDivider(color = trailGrid)
            if (selected == null) {
                Text("Open a ledger entry to trace its hours into the budget.", style = MaterialTheme.typography.bodySmall, color = FieldPalette.LightMuted)
            } else if (trace == null) {
                Text(
                    if (selected.status == CardStatus.RETURNED) "Returned hours have no effect on approved labour."
                    else "No recorded cost is available for this entry.",
                    style = MaterialTheme.typography.bodySmall,
                    color = FieldPalette.LightMuted,
                )
            } else {
                CostTrail(selected, trace, budget, if (animating) shown else trace.after, inletProgress)
            }
        }
    }
}

@Composable
private fun CostTrail(card: Timecard, trace: ManagerTrace, budget: Long, shown: Long, inletProgress: Float?) {
    val window = remember(trace, budget) { costWindow(trace.before, trace.after, budget) }
    val layers = remember(card, trace) { costLayers(trace.before, trace.after, card.hours, card.rateCents) }
    Text("Work becomes cost", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
    RegisterLabel("COST TRAIL  /  ${reference(card)}", trailCopper)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Column(
            modifier = Modifier.height(134.dp).padding(vertical = 3.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            val scaleStyle = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace)
            Text(formatCad(window.end), style = scaleStyle, color = FieldPalette.LightMuted)
            Text(formatCad(window.start), style = scaleStyle, color = FieldPalette.LightMuted)
        }
        TrailCanvas(window, layers, trace, budget, shown, inletProgress, Modifier.weight(1f))
    }
    Text(
        if (budget in window) "Dashed rule  ·  ${formatCad(budget)} budget"
        else "Project budget  ·  ${formatCad(budget)}  ·  Outside detail range",
        style = MaterialTheme.typography.bodySmall,
        color = FieldPalette.LightMuted,
    )
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Metric(trace.beforeLabel, formatCad(trace.before), Modifier.weight(1f))
        Metric(trace.postingLabel, "+${formatCad(trace.after - trace.before)}", Modifier.weight(1f), trailCopper)
        Metric(trace.afterLabel, formatCad(trace.after), Modifier.weight(1f))
    }
    Text(
        when {
            trace.forecast -> "Forecast only. Pending estimates stay outside approved labour."
            card.rateCents == null -> "Recorded posting for ${formatHours(card.hours)} hours."
            else -> "${formatHours(card.hours)} hours × ${formatCad(card.rateCents)}/hr. Each full layer represents one hour."
        },
        style = MaterialTheme.typography.bodySmall,
        color = FieldPalette.LightMuted,
    )
}

@Composable
private fun Metric(label: String, value: String, modifier: Modifier, color: Color = FieldPalette.LightInk) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = FieldPalette.LightMuted)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = color, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun TrailCanvas(
    window: CostWindow,
    layers: List<CostLayer>,
    trace: ManagerTrace,
    budget: Long,
    shown: Long,
    inletProgress: Float?,
    modifier: Modifier,
) {
    val mode = if (trace.forecast) "Estimated posting" else "Approved posting"
    val description = "$mode from ${formatCad(trace.before)} to ${formatCad(trace.after)}. Budget ${formatCad(budget)}."
    Canvas(
        modifier.height(134.dp).testTag("manager-trail")
            .semantics { contentDescription = description },
    ) {
        val pad = 5.dp.toPx()
        val field = size.width - pad * 2
        val inlet = pad + field * .35f
        val outlet = pad + field * .68f
        val width = outlet - inlet
        val height = size.height - pad * 2
        if (field <= 0f || height <= 0f) return@Canvas
        val base = size.height - pad
        val stroke = 1.dp.toPx()
        fun y(value: Long) = base - window.fraction(value) * height
        for (index in 0..6) {
            val column = pad + field * index / 6
            drawLine(trailGrid.copy(alpha = .47f), Offset(column, pad), Offset(column, base), stroke)
        }
        for (index in 0..4) {
            val row = pad + height * index / 4
            drawLine(trailGrid.copy(alpha = .47f), Offset(pad, row), Offset(pad + field, row), stroke)
        }
        layers.forEach { layer ->
            val end = if (trace.forecast) layer.to else minOf(shown, layer.to)
            if (end > layer.from) {
                val top = y(end)
                val bottom = y(layer.from)
                if (trace.forecast) {
                    drawRect(trailCopper.copy(alpha = .24f), Offset(inlet, top), Size(width, bottom - top))
                    drawLine(trailCopper.copy(alpha = .5f), Offset(inlet, top), Offset(outlet, top), stroke)
                } else {
                    val split = y(budget.coerceIn(layer.from, end))
                    drawRect(trailCopper, Offset(inlet, split), Size(width, bottom - split))
                    drawRect(trailOver, Offset(inlet, top), Size(width, split - top))
                    clipRect(inlet, top, outlet, bottom) {
                        val step = 9.dp.toPx()
                        var x = inlet - height
                        while (x < outlet) {
                            drawLine(FieldPalette.Forest.copy(alpha = .18f), Offset(x, bottom), Offset(x + bottom - top, top), stroke)
                            x += step
                        }
                    }
                    drawLine(FieldPalette.Forest.copy(alpha = .7f), Offset(inlet, top), Offset(outlet, top), stroke)
                }
            }
        }
        if (budget in window) {
            val budgetY = y(budget)
            drawLine(
                trailCopper,
                Offset(pad, budgetY),
                Offset(pad + field, budgetY),
                if (shown == budget && !trace.forecast) 2.dp.toPx() else stroke,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 4.dp.toPx())),
            )
        }
        val left = pad + 10.dp.toPx()
        val right = size.width - pad - 10.dp.toPx()
        val beforeY = y(trace.before)
        val afterY = y(shown)
        val endpoint = if (shown > budget) trailOver else trailCopper
        drawLine(trailCopper, Offset(left, beforeY), Offset(inlet, beforeY), stroke)
        drawCircle(trailCopper, 3.dp.toPx(), Offset(left, beforeY), style = Stroke(stroke))
        drawLine(
            endpoint, Offset(outlet, afterY), Offset(right, afterY), stroke,
            pathEffect = if (trace.forecast) PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())) else null,
        )
        drawCircle(endpoint, 3.dp.toPx(), Offset(right, afterY), style = if (trace.forecast) Stroke(stroke) else Fill)
        if (inletProgress != null) {
            val x = left + (inlet - left) * inletProgress
            drawCircle(trailCopper, 4.dp.toPx(), Offset(x, beforeY))
        }
    }
}

@Composable
private fun LedgerFilter(text: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(text) },
        modifier = Modifier.testTag(tag),
        colors = FilterChipDefaults.filterChipColors(
            labelColor = FieldPalette.Ink,
            selectedContainerColor = FieldPalette.CopperWash,
            selectedLabelColor = FieldPalette.Ink,
        ),
    )
}

@Composable
private fun LedgerRow(card: Timecard, onClick: () -> Unit) {
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 68.dp)
                .clickable(onClickLabel = "Open timecard", onClick = onClick)
                .testTag("manager-entry-${card.id}").padding(vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(card.workerName, style = MaterialTheme.typography.titleSmall, color = FieldPalette.Ink)
                Text(
                    "${workDay(card.workDate)} · ${formatHours(card.hours)} h",
                    style = MaterialTheme.typography.bodySmall,
                    color = FieldPalette.Muted,
                )
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                val cost = card.costCents?.let(::formatCad)
                Text(
                    when {
                        cost == null -> "—"
                        card.status == CardStatus.APPROVED -> cost
                        else -> "$cost est."
                    },
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(card.status.label, style = MaterialTheme.typography.labelMedium, color = statusColour(card.status))
            }
            Text("›", style = MaterialTheme.typography.titleLarge, color = FieldPalette.Copper)
        }
        HorizontalDivider(color = FieldPalette.Rule)
    }
}

@Composable
private fun SourceRecord(card: Timecard) {
    Column(Modifier.padding(top = 24.dp).testTag("manager-source"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        RegisterLabel("SOURCE RECORD  /  ${reference(card)}")
        Text("Source timecard", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
        Text("${card.workerName} · ${workDay(card.workDate)}", style = MaterialTheme.typography.bodyLarge, color = FieldPalette.Ink)
        RegisterLabel(card.status.label.uppercase(Locale.ROOT), statusColour(card.status))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SourceFact("Hours worked", "${formatHours(card.hours)} hrs", Modifier.weight(1f))
            SourceFact(
                if (card.status == CardStatus.APPROVED) "Applied rate" else "Estimated rate",
                card.rateCents?.let { "${formatCad(it)}/hr" } ?: "Unavailable",
                Modifier.weight(1f),
            )
        }
        SourceFact(
            if (card.status == CardStatus.APPROVED) "Posted cost" else "Estimated cost",
            card.costCents?.let(::formatCad) ?: "Unavailable",
            Modifier.fillMaxWidth(),
        )
        HorizontalDivider(color = FieldPalette.Rule)
    }
}

@Composable
private fun SourceFact(label: String, value: String, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = FieldPalette.Muted)
        Text(value, style = MaterialTheme.typography.titleMedium, color = FieldPalette.Ink)
    }
}

@Composable
private fun PostingActivity(card: Timecard) {
    Column(Modifier.padding(top = 17.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Activity", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
        if (card.audit.isEmpty()) {
            Text("No activity is recorded for this timecard.", style = MaterialTheme.typography.bodyMedium, color = FieldPalette.Muted)
        }
        card.audit.forEach { event ->
            val label = when (event.action.lowercase(Locale.ROOT)) {
                "submitted" -> "Submitted"
                "returned" -> "Returned for correction"
                "resubmitted" -> "Corrected and resubmitted"
                "approved" -> "Approved"
                else -> "Recorded update"
            }
            HorizontalDivider(color = FieldPalette.Rule)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(label, style = MaterialTheme.typography.titleSmall)
                Text("${event.actor} · ${auditTime(event.at)}", style = MaterialTheme.typography.bodySmall, color = FieldPalette.Muted)
                event.previousHours?.let { hours ->
                    val date = event.previousWorkDate?.let { " · ${workDay(it)}" }.orEmpty()
                    Text("Previous entry · ${formatHours(hours)} h$date", style = MaterialTheme.typography.bodyMedium, color = FieldPalette.Muted)
                }
                event.hours?.let { hours ->
                    val date = event.workDate?.let { " · ${workDay(it)}" }.orEmpty()
                    Text("Recorded entry · ${formatHours(hours)} h$date", style = MaterialTheme.typography.bodyMedium)
                }
                event.note?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = FieldPalette.Copper) }
            }
        }
    }
}
