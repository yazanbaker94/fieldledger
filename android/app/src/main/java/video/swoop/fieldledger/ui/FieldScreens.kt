package video.swoop.fieldledger.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import video.swoop.fieldledger.data.CardStatus
import video.swoop.fieldledger.data.Timecard
import video.swoop.fieldledger.data.Workspace
import video.swoop.fieldledger.data.formatCad
import video.swoop.fieldledger.data.formatHours
import video.swoop.fieldledger.data.isValidHours
import video.swoop.fieldledger.data.isValidReturnReason
import video.swoop.fieldledger.data.projectToday
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private const val ExampleNote = "Please include the final hour spent on site. The shift should total 8 hours."
private const val DayMillis = 86_400_000L
private val Toronto = ZoneId.of("America/Toronto")
private val ShortDate = DateTimeFormatter.ofPattern("MMM d, uuuu", Locale.CANADA)
private val EventDate = DateTimeFormatter.ofPattern("MMM d · h:mm a", Locale.CANADA)
private val HoursInput = Regex("^(?:[0-9]{1,2}(?:\\.[0-9]{1,2})?|\\.[0-9]{1,2})$")
private val RegisterShape = RoundedCornerShape(8.dp)
private val ControlShape = RoundedCornerShape(6.dp)
private val ReturnInk = Color(0xFF773D32)
private val ReturnWash = Color(0xFFF3E3DA)
private val ApprovedInk = Color(0xFF365741)
private val ApprovedWash = Color(0xFFE5EBDF)
private val PendingInk = Color(0xFF644528)
private val PendingWash = Color(0xFFF1E4CE)

@Composable
fun WorkerScreen(
    workspace: Workspace,
    busy: Boolean,
    cardId: String?,
    editing: Boolean,
    onOpen: (String) -> Unit,
    onEdit: (String) -> Unit,
    onSubmit: (String, Double) -> Unit,
    onResubmit: (Timecard, String, Double) -> Unit,
    onBack: () -> Unit,
) {
    val own = workspace.timecards.filter(workspace::belongsToWorker).sortedBy { statusOrder(it.status) }
    if (cardId == null) {
        var all by rememberSaveable(workspace.workspaceId) { mutableStateOf(false) }
        val visible = if (all) own else own.take(6)
        LazyColumn(
            modifier = Modifier.fillMaxWidth().imePadding().testTag("worker-scroll"),
            contentPadding = fieldPadding(),
        ) {
            item {
                FieldHeading("FIELD TIMEKEEPING", "Log a timecard", workspace.worker.name)
                ProjectRegister(workspace)
                Spacer(Modifier.height(20.dp))
                ShiftEditor(workspace.workspaceId, null, busy, onSubmit)
                Spacer(Modifier.height(24.dp))
                SectionLabel("My timecards", "${own.size} on record")
                if (own.isEmpty()) EmptyLine("Your submitted shifts will appear here.")
            }
            items(visible, key = { it.id }) { card ->
                FieldCardRow(card, "worker-card-${card.id}", workerView = true, onClick = { onOpen(card.id) })
            }
            if (own.size > 6) {
                item {
                    TextButton(onClick = { all = !all }) {
                        Text(if (all) "Show recent shifts" else "View all ${own.size} shifts")
                    }
                }
            }
        }
        return
    }

    val card = own.firstOrNull { it.id == cardId }
    LazyColumn(
        modifier = Modifier.fillMaxWidth().imePadding().testTag("worker-scroll"),
        contentPadding = fieldPadding(),
    ) {
        item {
            BackLink("My timecards", onBack)
            if (card == null) {
                FieldHeading("FIELD TIMEKEEPING", "Timecard unavailable", "Choose a shift from your timecards.")
                return@item
            }
            val correcting = editing && card.status == CardStatus.RETURNED
            FieldHeading(
                if (correcting) "SHIFT CORRECTION" else "SOURCE TIMECARD",
                if (correcting) "Correct timecard" else "Timecard detail",
                workspace.project.name,
            )
            TimecardRegister(card, showCost = false)
            if (card.status == CardStatus.RETURNED && !card.reason.isNullOrBlank()) {
                Spacer(Modifier.height(16.dp))
                CorrectionStrip(card.reason.orEmpty())
            }
            Spacer(Modifier.height(18.dp))
            if (correcting) {
                ShiftEditor(workspace.workspaceId, card, busy) { date, hours ->
                    onResubmit(card, date, hours)
                }
            } else if (card.status == CardStatus.RETURNED) {
                FieldAction("Correct timecard", onClick = { onEdit(card.id) }, enabled = !busy, tag = "worker-correct")
            }
            Spacer(Modifier.height(24.dp))
            FieldActivity(card)
        }
    }
}

@Composable
fun ForemanScreen(
    workspace: Workspace,
    busy: Boolean,
    cardId: String?,
    onOpen: (String) -> Unit,
    onDecide: (Timecard, Boolean, String?) -> Unit,
    onBack: () -> Unit,
) {
    if (cardId == null) {
        var recentOnly by rememberSaveable(workspace.workspaceId) { mutableStateOf(false) }
        val pending = workspace.timecards.filter { it.status == CardStatus.PENDING }
        val returnedCount = workspace.timecards.count { it.status == CardStatus.RETURNED }
        val approvals = workspace.timecards.filter { it.status == CardStatus.APPROVED }
            .sortedByDescending { it.decisionAt.orEmpty() }
        val visible = if (recentOnly) approvals else pending
        LazyColumn(contentPadding = fieldPadding(), modifier = Modifier.fillMaxWidth().testTag("foreman-scroll")) {
            item {
                FieldHeading("CREW SUPERVISION", "Review timecards", workspace.foreman.name)
                ProjectRegister(workspace)
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = !recentOnly,
                        onClick = { recentOnly = false },
                        label = { Text("Queue · ${pending.size}") },
                        shape = ControlShape,
                    )
                    FilterChip(
                        selected = recentOnly,
                        onClick = { recentOnly = true },
                        label = { Text("Recent approvals") },
                        shape = ControlShape,
                    )
                }
                Spacer(Modifier.height(10.dp))
                SectionLabel(if (recentOnly) "Recently approved" else "Review queue", "${visible.size} shifts")
                if (visible.isEmpty()) {
                    EmptyLine(
                        if (recentOnly) "Approved timecards will appear here."
                        else "Queue clear. New and corrected shifts will appear when ready for review.",
                    )
                }
            }
            items(visible, key = { it.id }) { card ->
                FieldCardRow(card, "foreman-card-${card.id}", workerView = false, onClick = { onOpen(card.id) })
            }
            if (!recentOnly && returnedCount > 0) {
                item {
                    Text(
                        if (returnedCount == 1) "1 shift is with the worker for correction."
                        else "$returnedCount shifts are with workers for correction.",
                        Modifier.padding(vertical = 14.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = FieldPalette.Copper,
                    )
                }
            }
            if (!recentOnly && approvals.isNotEmpty()) {
                item {
                    Spacer(Modifier.height(20.dp))
                    SectionLabel("Crew activity", "Latest approvals")
                }
                items(approvals.take(3), key = { "recent-${it.id}" }) { card ->
                    FieldCardRow(card, "foreman-card-${card.id}", workerView = false, onClick = { onOpen(card.id) })
                }
            }
        }
        return
    }

    val card = workspace.timecards.firstOrNull { it.id == cardId }
    var returning by rememberSaveable(workspace.workspaceId, cardId) { mutableStateOf(false) }
    val pending = card?.status == CardStatus.PENDING
    LaunchedEffect(pending) { if (!pending) returning = false }
    BackHandler(enabled = pending && returning && !busy) { returning = false }
    LazyColumn(
        modifier = Modifier.fillMaxWidth().imePadding().testTag("foreman-scroll"),
        contentPadding = fieldPadding(),
    ) {
        item {
            BackLink("Review queue", onBack)
            if (card == null) {
                FieldHeading("CREW SUPERVISION", "Timecard unavailable", "Choose a shift from the review queue.")
                return@item
            }
            FieldHeading("TIMECARD REVIEW", card.workerName, workspace.project.name)
            TimecardRegister(card, showCost = true)
            if (pending) {
                Spacer(Modifier.height(20.dp))
                DecisionEditor(
                    workspace.workspaceId,
                    card,
                    busy,
                    returning,
                    onReturning = { returning = it },
                    onDecide = onDecide,
                )
            }
            Spacer(Modifier.height(24.dp))
            FieldActivity(card)
        }
    }
}

@Composable
private fun ShiftEditor(
    workspaceId: String,
    card: Timecard?,
    busy: Boolean,
    onSave: (String, Double) -> Unit,
) {
    var date by rememberSaveable(workspaceId, card?.id) {
        mutableStateOf(card?.workDate ?: projectToday().toString())
    }
    var hours by rememberSaveable(workspaceId, card?.id) { mutableStateOf(card?.hours?.let(::formatHours) ?: "8") }
    var revision by rememberSaveable(workspaceId, card?.id) { mutableIntStateOf(card?.version ?: 0) }
    val currentDate = projectToday()
    val chosenDate = parseDate(date)
    val validDate = chosenDate != null && chosenDate.year >= 2000 && chosenDate <= currentDate
    val enteredHours = parseHours(hours)
    val stale = card != null && revision != card.version
    val correction = card != null
    val valid = validDate && enteredHours != null && !busy && !stale
    val focus = LocalFocusManager.current
    if (!correction) SectionLabel("New timecard", "Regular hours")
    if (stale) {
        CorrectionStrip("This shift changed while you were editing. Load the current entry before saving.")
        TextButton(onClick = {
            date = card.workDate
            hours = formatHours(card.hours)
            revision = card.version
        }, enabled = !busy) { Text("Load current entry") }
    }
    Spacer(Modifier.height(10.dp))
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val wide = maxWidth >= 320.dp && LocalDensity.current.fontScale <= 1.2f
        val dateField: @Composable (Modifier) -> Unit = { modifier ->
            WorkDateField(date, currentDate, !busy && !stale, modifier) { date = it }
        }
        val hoursField: @Composable (Modifier) -> Unit = { modifier ->
            OutlinedTextField(
                value = hours,
                onValueChange = { hours = it.take(10) },
                modifier = modifier.testTag("worker-hours"),
                label = { Text("Hours worked") },
                suffix = { Text("h") },
                enabled = !busy && !stale,
                isError = hours.isNotBlank() && enteredHours == null,
                singleLine = true,
                shape = ControlShape,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
            )
        }
        if (wide) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                dateField(Modifier.weight(1.1f))
                hoursField(Modifier.weight(1f))
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                dateField(Modifier.fillMaxWidth())
                hoursField(Modifier.fillMaxWidth())
            }
        }
    }
    if (hours.isNotBlank() && enteredHours == null) {
        Text(
            "Enter 0.01 to 24 hours, with up to two decimal places.",
            Modifier.padding(top = 5.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }
    val example = card == null || card.reason == ExampleNote
    if (example) {
        Spacer(Modifier.height(12.dp))
        Box(
            Modifier.fillMaxWidth().clip(ControlShape).background(FieldPalette.CopperWash)
                .border(1.dp, FieldPalette.Copper.copy(alpha = .22f), ControlShape),
        ) {
            Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 2.dp)) {
                Text(
                    if (correction) "Complete the example shift" else "Try the correction walkthrough",
                    style = MaterialTheme.typography.titleSmall,
                    color = FieldPalette.Ink,
                )
                Text(
                    if (correction) "Add the missing hour and resubmit for review."
                    else "Submit seven hours, then follow the shift to the foreman.",
                    style = MaterialTheme.typography.bodySmall,
                    color = FieldPalette.Muted,
                )
                TextButton(
                    onClick = { hours = if (correction) "8" else "7" },
                    enabled = !busy && !stale,
                    modifier = Modifier.testTag(if (correction) "worker-correct-example" else "worker-example"),
                    contentPadding = PaddingValues(horizontal = 0.dp, vertical = 8.dp),
                ) {
                    Text(if (correction) "Use 8 hours" else "Use 7 hours", color = FieldPalette.Copper)
                }
            }
        }
    }
    Spacer(Modifier.height(14.dp))
    FieldAction(
        text = if (busy) "Saving…" else if (correction) "Resubmit timecard" else "Submit timecard",
        onClick = {
            if (valid) {
                focus.clearFocus()
                onSave(date, enteredHours)
            }
        },
        enabled = valid,
        tag = if (correction) "worker-resubmit" else "worker-submit",
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WorkDateField(
    date: String,
    maximum: LocalDate,
    enabled: Boolean,
    modifier: Modifier,
    onDate: (String) -> Unit,
) {
    var show by rememberSaveable { mutableStateOf(false) }
    val earliest = LocalDate.of(2000, 1, 1)
    val current = parseDate(date)?.coerceIn(earliest, maximum) ?: maximum
    OutlinedButton(
        onClick = { show = true },
        enabled = enabled,
        modifier = modifier.heightIn(min = 56.dp).testTag("worker-date"),
        shape = ControlShape,
        contentPadding = PaddingValues(horizontal = 13.dp, vertical = 8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text("Work date", style = MaterialTheme.typography.labelMedium, color = FieldPalette.Muted)
            Text(fieldDate(date), style = MaterialTheme.typography.bodyMedium, color = FieldPalette.Ink)
        }
        CalendarMark(Modifier.size(19.dp))
    }
    if (show) {
        val selectable = remember(earliest, maximum) {
            object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                    LocalDate.ofEpochDay(Math.floorDiv(utcTimeMillis, DayMillis)) in earliest..maximum

                override fun isSelectableYear(year: Int): Boolean = year in earliest.year..maximum.year
            }
        }
        val picker = rememberDatePickerState(
            initialSelectedDateMillis = current.toEpochDay() * DayMillis,
            yearRange = earliest.year..maximum.year,
            selectableDates = selectable,
        )
        DatePickerDialog(
            onDismissRequest = { show = false },
            confirmButton = {
                TextButton(
                    enabled = picker.selectedDateMillis?.let(selectable::isSelectableDate) == true,
                    onClick = {
                        picker.selectedDateMillis?.let { milliseconds ->
                            onDate(LocalDate.ofEpochDay(Math.floorDiv(milliseconds, DayMillis)).toString())
                        }
                        show = false
                    },
                ) { Text("Use date") }
            },
            dismissButton = { TextButton(onClick = { show = false }) { Text("Cancel") } },
        ) {
            DatePicker(state = picker)
        }
    }
}

@Composable
private fun DecisionEditor(
    workspaceId: String,
    card: Timecard,
    busy: Boolean,
    returning: Boolean,
    onReturning: (Boolean) -> Unit,
    onDecide: (Timecard, Boolean, String?) -> Unit,
) {
    var reviewedVersion by rememberSaveable(workspaceId, card.id) { mutableIntStateOf(card.version) }
    var note by rememberSaveable(workspaceId, card.id) { mutableStateOf("") }
    val current = reviewedVersion == card.version && card.status == CardStatus.PENDING
    val canReturn = card.canReturn != false
    val noteValid = isValidReturnReason(note)
    val focus = LocalFocusManager.current
    SectionLabel("Review decision", if (card.status == CardStatus.PENDING) "Pending" else "Read only")
    Spacer(Modifier.height(8.dp))
    if (!current) {
        CorrectionStrip(
            if (card.status == CardStatus.PENDING) "This shift changed. Review its current details before deciding."
            else "This shift is no longer pending.",
        )
        if (card.status == CardStatus.PENDING) {
            TextButton(onClick = { reviewedVersion = card.version }, enabled = !busy) {
                Text("Use current revision")
            }
        }
    }
    if (returning) {
        Text(
            "The worker will see this explanation on the returned timecard.",
            style = MaterialTheme.typography.bodyMedium,
            color = FieldPalette.Muted,
            modifier = Modifier.padding(vertical = 6.dp),
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it.take(500) },
            label = { Text("Correction note") },
            modifier = Modifier.fillMaxWidth().testTag("foreman-note"),
            enabled = !busy && current && canReturn,
            shape = ControlShape,
            minLines = 3,
            maxLines = 6,
            isError = note.isNotEmpty() && !noteValid,
            supportingText = if (note.isNotEmpty() && !noteValid) {
                { Text("Enter a visible explanation.") }
            } else {
                null
            },
        )
        if (card.hours == 7.0 && !noteValid) {
            TextButton(
                onClick = { note = ExampleNote },
                enabled = !busy && current && canReturn,
                modifier = Modifier.testTag("foreman-example"),
            ) { Text("Use example note") }
        } else {
            Spacer(Modifier.height(10.dp))
        }
        FieldAction(
            text = "Send back to worker",
            enabled = !busy && current && canReturn && noteValid,
            tag = "foreman-send",
            onClick = {
                focus.clearFocus()
                onDecide(card, false, note.trim())
            },
        )
        TextButton(onClick = {
            focus.clearFocus()
            onReturning(false)
        }, enabled = !busy) { Text("Cancel return") }
        return
    }
    Text(
        if (card.hours == 7.0 && canReturn) "For the walkthrough, return this shift to add the missing hour."
        else "Approval posts the reviewed labour cost to the project ledger.",
        style = MaterialTheme.typography.bodyMedium,
        color = FieldPalette.Muted,
    )
    Spacer(Modifier.height(12.dp))
    FieldAction(
        text = "Approve timecard",
        enabled = !busy && current,
        onClick = { onDecide(card, true, null) },
        tag = "foreman-approve",
    )
    if (canReturn) {
        OutlinedButton(
            onClick = { onReturning(true) },
            enabled = !busy && current,
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp).testTag("foreman-return"),
            shape = ControlShape,
            contentPadding = PaddingValues(vertical = 13.dp, horizontal = 16.dp),
        ) { Text("Return with a note") }
    }
}

@Composable
private fun FieldHeading(kicker: String, title: String, subtitle: String) {
    Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
        FieldKicker(kicker, FieldPalette.Copper)
        Spacer(Modifier.height(3.dp))
        Text(
            title,
            Modifier.semantics { heading() },
            style = MaterialTheme.typography.headlineLarge,
            fontFamily = FontFamily.Serif,
            color = FieldPalette.Ink,
        )
        Spacer(Modifier.height(3.dp))
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = FieldPalette.Muted)
    }
}

@Composable
private fun ProjectRegister(workspace: Workspace) {
    val project = workspace.project
    Box(Modifier.fillMaxWidth().clip(RegisterShape).background(FieldPalette.Forest)) {
        Canvas(Modifier.matchParentSize()) {
            val step = 13.dp.toPx()
            val start = size.width * .56f
            val color = FieldPalette.LightInk.copy(alpha = .07f)
            var x = start
            while (x <= size.width) {
                drawLine(color, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1.dp.toPx())
                x += step
            }
            var y = 0f
            while (y <= size.height) {
                drawLine(color, Offset(start, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
                y += step
            }
        }
        Column(Modifier.padding(15.dp)) {
            FieldKicker("ASSIGNED PROJECT  /  ${project.code}", FieldPalette.LightMuted)
            Spacer(Modifier.height(3.dp))
            Text(
                project.name,
                color = FieldPalette.LightInk,
                style = MaterialTheme.typography.titleLarge,
                fontFamily = FontFamily.Serif,
            )
            Text(project.location, color = FieldPalette.LightMuted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun TimecardRegister(card: Timecard, showCost: Boolean) {
    Column(
        Modifier.fillMaxWidth().clip(RegisterShape).background(FieldPalette.Paper)
            .border(1.dp, FieldPalette.Rule, RegisterShape).padding(15.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            FieldKicker(card.id.take(8).uppercase(Locale.ROOT), FieldPalette.Copper, Modifier.weight(1f))
            FieldStatus(card.status)
        }
        Spacer(Modifier.height(10.dp))
        HorizontalDivider(color = FieldPalette.Rule)
        Spacer(Modifier.height(10.dp))
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val inline = maxWidth >= 250.dp && LocalDensity.current.fontScale < 1.35f
            if (inline) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FieldFact("Work date", fieldDate(card.workDate), Modifier.weight(1f))
                    FieldFact("Hours worked", "${formatHours(card.hours)} hrs", Modifier.weight(.75f))
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    FieldFact("Work date", fieldDate(card.workDate))
                    FieldFact("Hours worked", "${formatHours(card.hours)} hrs")
                }
            }
        }
        if (showCost) {
            Spacer(Modifier.height(10.dp))
            HorizontalDivider(color = FieldPalette.Copper.copy(alpha = .35f))
            Spacer(Modifier.height(9.dp))
            Text(
                if (card.status == CardStatus.APPROVED) "Posted labour" else "Estimated labour",
                style = MaterialTheme.typography.labelMedium,
                color = FieldPalette.Copper,
            )
            Text(
                card.costCents?.let(::formatCad) ?: "Rate unavailable",
                style = MaterialTheme.typography.headlineMedium,
                fontFamily = FontFamily.Serif,
                color = FieldPalette.Copper,
            )
            card.rateCents?.let {
                Text(
                    "${formatHours(card.hours)} hrs × ${formatCad(it)}/hr",
                    color = FieldPalette.Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun FieldCardRow(card: Timecard, tag: String, workerView: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().testTag(tag).clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 2.dp, vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                if (workerView) fieldDate(card.workDate) else card.workerName,
                style = MaterialTheme.typography.titleSmall,
                color = FieldPalette.Ink,
            )
            Text(
                if (workerView) "${formatHours(card.hours)} hrs"
                else "${fieldDate(card.workDate)} · ${formatHours(card.hours)} hrs",
                color = FieldPalette.Muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        FieldStatus(card.status)
        Text("›", Modifier.clearAndSetSemantics {}, color = FieldPalette.Copper, style = MaterialTheme.typography.titleMedium)
    }
    HorizontalDivider(color = FieldPalette.Rule)
}

@Composable
private fun FieldStatus(status: CardStatus) {
    val (title, ink, wash) = when (status) {
        CardStatus.PENDING -> Triple("Pending", PendingInk, PendingWash)
        CardStatus.RETURNED -> Triple("Returned", ReturnInk, ReturnWash)
        CardStatus.APPROVED -> Triple("Approved", ApprovedInk, ApprovedWash)
    }
    Row(
        modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(wash)
            .padding(horizontal = 7.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(5.dp).background(ink, CircleShape))
        Text(title, color = ink, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun FieldActivity(card: Timecard) {
    SectionLabel("Activity", "Toronto time")
    if (card.audit.isEmpty()) {
        EmptyLine("No activity was recorded for this shift.")
    }
    for (event in card.audit) {
        val action = when (event.action) {
            "submitted" -> "Submitted"
            "returned" -> "Returned for correction"
            "resubmitted" -> "Resubmitted"
            "approved" -> "Approved"
            else -> "Timecard updated"
        }
        Row(
            Modifier.fillMaxWidth().padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Box(Modifier.padding(top = 7.dp).size(6.dp).background(FieldPalette.Copper, CircleShape))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(action, style = MaterialTheme.typography.titleSmall, color = FieldPalette.Ink)
                Text(
                    "${event.actor} · ${fieldEventDate(event.at)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = FieldPalette.Muted,
                )
                val previous = event.previousHours
                val previousDate = event.previousWorkDate
                if (previous != null && previousDate != null) {
                    Text(
                        "Previous · ${formatHours(previous)} hrs · ${fieldDate(previousDate)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = FieldPalette.Muted,
                    )
                }
                val hours = event.hours
                val date = event.workDate
                if (hours != null && date != null) {
                    Text(
                        "${formatHours(hours)} hrs · ${fieldDate(date)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = FieldPalette.Muted,
                    )
                }
                event.note?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = ReturnInk)
                }
            }
        }
        HorizontalDivider(color = FieldPalette.Rule)
    }
}

@Composable
private fun SectionLabel(label: String, detail: String) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(label, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
        Text(detail, style = MaterialTheme.typography.labelMedium, color = FieldPalette.Muted)
    }
    HorizontalDivider(color = FieldPalette.Rule)
}

@Composable
private fun FieldFact(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = FieldPalette.Muted)
        Text(value, style = MaterialTheme.typography.titleMedium, color = FieldPalette.Ink)
    }
}

@Composable
private fun FieldKicker(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp,
        letterSpacing = .4.sp,
        color = color,
    )
}

@Composable
private fun CorrectionStrip(note: String) {
    Row(
        Modifier.fillMaxWidth().clip(ControlShape).background(ReturnWash).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Text("↶", Modifier.clearAndSetSemantics {}, color = ReturnInk, style = MaterialTheme.typography.titleMedium)
        Column {
            Text("Correction note", style = MaterialTheme.typography.titleSmall, color = ReturnInk)
            Text(note, style = MaterialTheme.typography.bodyMedium, color = ReturnInk)
        }
    }
}

@Composable
private fun FieldAction(text: String, onClick: () -> Unit, enabled: Boolean, tag: String) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag(tag),
        enabled = enabled,
        shape = ControlShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = FieldPalette.Forest,
            contentColor = FieldPalette.LightInk,
        ),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 13.dp),
    ) {
        Text(text, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
        Text("→", Modifier.padding(start = 8.dp).clearAndSetSemantics {}, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun BackLink(label: String, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 8.dp),
    ) { Text("‹  $label", color = FieldPalette.Copper) }
}

@Composable
private fun EmptyLine(copy: String) {
    Text(copy, Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.bodyMedium, color = FieldPalette.Muted)
}

@Composable
private fun CalendarMark(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val ink = FieldPalette.Copper
        val stroke = 1.3.dp.toPx()
        val left = size.width * .14f
        val right = size.width * .86f
        val top = size.height * .23f
        val bottom = size.height * .88f
        drawLine(ink, Offset(left, top), Offset(right, top), stroke)
        drawLine(ink, Offset(right, top), Offset(right, bottom), stroke)
        drawLine(ink, Offset(right, bottom), Offset(left, bottom), stroke)
        drawLine(ink, Offset(left, bottom), Offset(left, top), stroke)
        drawLine(ink, Offset(left, size.height * .44f), Offset(right, size.height * .44f), stroke)
        drawLine(ink, Offset(size.width * .33f, size.height * .09f), Offset(size.width * .33f, size.height * .34f), stroke)
        drawLine(ink, Offset(size.width * .67f, size.height * .09f), Offset(size.width * .67f, size.height * .34f), stroke)
    }
}

private fun fieldPadding() = PaddingValues(start = 18.dp, top = 12.dp, end = 18.dp, bottom = 26.dp)

private fun statusOrder(status: CardStatus) = when (status) {
    CardStatus.RETURNED -> 0
    CardStatus.PENDING -> 1
    CardStatus.APPROVED -> 2
}

private fun parseDate(value: String): LocalDate? = runCatching { LocalDate.parse(value) }.getOrNull()

private fun fieldDate(value: String): String = parseDate(value)?.format(ShortDate) ?: value

private fun fieldEventDate(value: String): String = runCatching {
    OffsetDateTime.parse(value).atZoneSameInstant(Toronto).format(EventDate)
}.getOrDefault(value)

private fun parseHours(value: String): Double? {
    val normalized = buildString {
        for (character in value.trim()) {
            when (character) {
                ',', '٫' -> append('.')
                else -> append(character.digitToIntOrNull()?.digitToChar() ?: character)
            }
        }
    }
    if (!HoursInput.matches(normalized)) return null
    return normalized.toDoubleOrNull()?.takeIf(::isValidHours)
}
