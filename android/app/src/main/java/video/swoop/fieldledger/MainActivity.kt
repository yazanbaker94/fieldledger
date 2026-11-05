package video.swoop.fieldledger

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role as SemanticRole
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import video.swoop.fieldledger.data.FieldLedgerRepository
import video.swoop.fieldledger.data.Role
import video.swoop.fieldledger.data.formatHours
import video.swoop.fieldledger.ui.FieldPalette
import video.swoop.fieldledger.ui.FieldTheme
import video.swoop.fieldledger.ui.ForemanScreen
import video.swoop.fieldledger.ui.ManagerScreen
import video.swoop.fieldledger.ui.WorkerScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val transparent = android.graphics.Color.TRANSPARENT
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(transparent, transparent),
            navigationBarStyle = SystemBarStyle.light(transparent, transparent),
        )
        val repository = FieldLedgerRepository(applicationContext, BuildConfig.API_ORIGIN)
        setContent {
            FieldTheme {
                val model = viewModel<FieldLedgerViewModel> { FieldLedgerViewModel(repository) }
                FieldLedgerApp(model)
            }
        }
    }
}

private val Role.route get() = name.lowercase()
private fun Handoff.route() = when (role) {
    Role.WORKER -> "worker/$cardId/$edit"
    Role.FOREMAN -> "foreman/$cardId"
    Role.MANAGER -> "manager/$cardId"
}

@Composable
private fun FieldLedgerApp(model: FieldLedgerViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val activeRole = Role.entries.firstOrNull { it.route == entry?.destination?.route?.substringBefore('/') } ?: Role.WORKER
    val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    var showReset by rememberSaveable { mutableStateOf(false) }
    var handledReset by remember { mutableIntStateOf(state.resetCount) }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.resumed() }
    LaunchedEffect(state.resetCount) {
        if (state.resetCount > handledReset) {
            handledReset = state.resetCount
            nav.navigate("worker") { popUpTo(nav.graph.id) { inclusive = true } }
        }
    }

    fun showRole(role: Role, restore: Boolean = false) {
        nav.navigate(role.route) {
            popUpTo("worker") { saveState = restore }
            launchSingleTop = true
            restoreState = restore
        }
    }

    fun backToRole(role: Role) {
        if (!nav.popBackStack(role.route, inclusive = false)) showRole(role)
    }

    fun follow(handoff: Handoff) {
        model.dismiss(keepPosting = handoff.role == Role.MANAGER)
        showRole(handoff.role)
        nav.navigate(handoff.route()) { launchSingleTop = true }
    }

    fun switch(role: Role) {
        val handoff = state.handoff?.takeIf { it.role == role }
        if (handoff != null) {
            follow(handoff)
        } else {
            val destination = nav.currentDestination?.route
            if (destination == role.route) return
            model.dismiss()
            if (destination?.substringBefore('/') == role.route) {
                backToRole(role)
            } else {
                showRole(role, restore = true)
            }
        }
    }

    Scaffold(
        containerColor = FieldPalette.Canvas,
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            WorkspaceMasthead(
                busy = state.busy, canReset = state.workspace != null,
                onRefresh = model::refresh, onReset = { showReset = true },
            )
        },
        bottomBar = {
            if (!keyboardOpen) RoleDock(activeRole, ::switch)
        },
    ) { insets ->
        Box(
            Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets).imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxSize()) {
                if (state.workspace != null) WorkspaceFeedback(state, model, ::follow)
                NavHost(
                    navController = nav,
                    startDestination = "worker",
                    modifier = Modifier.weight(1f),
                    enterTransition = { fadeIn(tween(140)) },
                    exitTransition = { fadeOut(tween(110)) },
                    popEnterTransition = { fadeIn(tween(140)) },
                    popExitTransition = { fadeOut(tween(110)) },
                ) {
                    composable("worker") {
                        val workspace = state.workspace
                        if (workspace == null) WorkspacePlaceholder(state, model::refresh)
                        else WorkerScreen(
                            workspace, state.busy, null, false,
                            onOpen = { nav.navigate("worker/$it/false") },
                            onEdit = { nav.navigate("worker/$it/true") },
                            onSubmit = model::submit,
                            onResubmit = model::resubmit,
                            onBack = { backToRole(Role.WORKER) },
                        )
                    }
                    composable(
                        "worker/{id}/{edit}",
                        arguments = listOf(navArgument("id") { type = NavType.StringType }, navArgument("edit") { type = NavType.BoolType }),
                    ) { screen ->
                        val workspace = state.workspace
                        if (workspace == null) WorkspacePlaceholder(state, model::refresh)
                        else WorkerScreen(
                            workspace, state.busy, screen.arguments?.getString("id"), screen.arguments?.getBoolean("edit") == true,
                            onOpen = { nav.navigate("worker/$it/false") },
                            onEdit = { id ->
                                nav.navigate("worker/$id/true") { popUpTo("worker") }
                            },
                            onSubmit = model::submit,
                            onResubmit = model::resubmit,
                            onBack = { backToRole(Role.WORKER) },
                        )
                    }
                    composable("foreman") {
                        val workspace = state.workspace
                        if (workspace == null) WorkspacePlaceholder(state, model::refresh)
                        else ForemanScreen(
                            workspace, state.busy, null, onOpen = { nav.navigate("foreman/$it") },
                            onDecide = model::decide, onBack = { backToRole(Role.FOREMAN) },
                        )
                    }
                    composable("foreman/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { screen ->
                        val workspace = state.workspace
                        if (workspace == null) WorkspacePlaceholder(state, model::refresh)
                        else ForemanScreen(
                            workspace, state.busy, screen.arguments?.getString("id"), onOpen = { nav.navigate("foreman/$it") },
                            onDecide = model::decide, onBack = { backToRole(Role.FOREMAN) },
                        )
                    }
                    composable("manager") {
                        val workspace = state.workspace
                        if (workspace == null) WorkspacePlaceholder(state, model::refresh)
                        else ManagerScreen(
                            workspace, null, null, onOpen = { nav.navigate("manager/$it") },
                            onBack = { backToRole(Role.MANAGER) }, onPostingPlayed = model::postingPlayed,
                        )
                    }
                    composable("manager/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { screen ->
                        val workspace = state.workspace
                        if (workspace == null) WorkspacePlaceholder(state, model::refresh)
                        else ManagerScreen(
                            workspace, screen.arguments?.getString("id"), state.posting, onOpen = { nav.navigate("manager/$it") },
                            onBack = { model.postingPlayed(); backToRole(Role.MANAGER) }, onPostingPlayed = model::postingPlayed,
                        )
                    }
                }
            }
        }
    }

    if (showReset) {
        AlertDialog(
            onDismissRequest = { showReset = false },
            title = { Text("Start a fresh demo?", style = MaterialTheme.typography.headlineSmall) },
            text = { Text("Reset this workspace to the sample crew history and original labour budget.") },
            dismissButton = { TextButton(onClick = { showReset = false }) { Text("Cancel") } },
            confirmButton = {
                Button(onClick = { showReset = false; model.reset() }, enabled = !state.busy, modifier = Modifier.testTag("confirm-reset")) {
                    Text("Reset workspace")
                }
            },
        )
    }
}

@Composable
private fun WorkspaceMasthead(busy: Boolean, canReset: Boolean, onRefresh: () -> Unit, onReset: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Surface(color = FieldPalette.Paper) {
        Column(Modifier.statusBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 58.dp).padding(start = 18.dp, end = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Image(painterResource(R.drawable.fieldledger_icon), null, Modifier.size(29.dp))
                Text("FieldLedger", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                Text("Demo workspace", style = MaterialTheme.typography.bodySmall, color = FieldPalette.Muted)
                Box {
                    IconButton(onClick = { menu = true }, modifier = Modifier.testTag("workspace-options")
                        .semantics { contentDescription = "Workspace options" }) {
                        Canvas(Modifier.size(22.dp)) {
                            for (index in -1..1) drawCircle(FieldPalette.Ink, 1.5.dp.toPx(), center + Offset(0f, index * 5.dp.toPx()))
                        }
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Refresh workspace") }, enabled = !busy, onClick = { menu = false; onRefresh() })
                        DropdownMenuItem(text = { Text("Reset demo") }, enabled = !busy && canReset, onClick = { menu = false; onReset() })
                    }
                }
            }
            HorizontalDivider(color = FieldPalette.Rule)
        }
    }
}

@Composable
private fun RoleDock(active: Role, onSelect: (Role) -> Unit) {
    Surface(color = FieldPalette.Paper) {
        Column {
            HorizontalDivider(color = FieldPalette.Rule)
            Row(
                Modifier.fillMaxWidth().navigationBarsPadding().selectableGroup().padding(horizontal = 10.dp, vertical = 5.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                for (role in Role.entries) {
                    val selected = active == role
                    Column(
                        Modifier.weight(1f).testTag("role-${role.route}").selectable(selected, role = SemanticRole.Tab, onClick = { onSelect(role) })
                            .background(if (selected) FieldPalette.CopperWash else Color.Transparent, MaterialTheme.shapes.small)
                            .heightIn(min = 50.dp).padding(vertical = 6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        RoleGlyph(role, if (selected) FieldPalette.Copper else FieldPalette.Muted)
                        Text(role.label, style = MaterialTheme.typography.labelMedium, color = if (selected) FieldPalette.Ink else FieldPalette.Muted)
                    }
                }
            }
        }
    }
}

@Composable
private fun RoleGlyph(role: Role, color: Color) {
    Canvas(Modifier.size(17.dp)) {
        val step = size.width / 16f
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) {
            drawLine(color, Offset(x1 * step, y1 * step), Offset(x2 * step, y2 * step), 1.35.dp.toPx(), StrokeCap.Round)
        }
        when (role) {
            Role.WORKER -> {
                line(2f, 12f, 14f, 12f); line(4f, 11f, 4f, 7f); line(4f, 7f, 8f, 4f)
                line(8f, 4f, 12f, 7f); line(12f, 7f, 12f, 11f); line(8f, 4f, 8f, 8f)
            }
            Role.FOREMAN -> {
                line(4f, 3f, 12f, 3f); line(12f, 3f, 12f, 13f); line(12f, 13f, 4f, 13f)
                line(4f, 13f, 4f, 3f); line(6f, 8f, 7.5f, 9.5f); line(7.5f, 9.5f, 10f, 6.5f)
            }
            Role.MANAGER -> {
                line(2f, 13f, 14f, 13f); line(4f, 10f, 7f, 7f); line(7f, 7f, 9f, 8f)
                line(9f, 8f, 13f, 4f); line(3f, 5f, 5f, 5f)
            }
        }
    }
}

@Composable
private fun WorkspaceFeedback(state: WorkspaceUiState, model: FieldLedgerViewModel, onFollow: (Handoff) -> Unit) {
    val message = state.error ?: state.message
    if (message != null) {
        Surface(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            color = if (state.error != null) MaterialTheme.colorScheme.errorContainer else FieldPalette.CopperWash,
            shape = MaterialTheme.shapes.small,
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 5.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    TextButton(onClick = { model.dismiss() }) { Text("Dismiss", style = MaterialTheme.typography.labelMedium) }
                }
                state.handoff?.let {
                    Button(onClick = { onFollow(it) }, enabled = !state.busy, modifier = Modifier.testTag("handoff-${it.role.route}")) {
                        Text("Go to ${it.role.route}")
                    }
                }
            }
        }
    }
    state.pending?.let {
        Surface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            color = FieldPalette.Paper, shape = MaterialTheme.shapes.small,
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 5.dp)) {
                Text("Unconfirmed timecard · ${it.workDate} · ${formatHours(it.hours)} hrs", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = model::checkPending, enabled = !state.busy) { Text("Check saved") }
                    TextButton(onClick = model::discardPending, enabled = !state.busy) { Text("Discard attempt") }
                }
            }
        }
    }
}

@Composable
private fun WorkspacePlaceholder(state: WorkspaceUiState, retry: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.busy || state.error == null) {
                CircularProgressIndicator(Modifier.size(28.dp))
                Text("Opening your workspace…", style = MaterialTheme.typography.bodyMedium)
            } else {
                Text("Workspace unavailable", style = MaterialTheme.typography.headlineSmall)
                Text(state.error, style = MaterialTheme.typography.bodyMedium)
                Button(onClick = retry) { Text("Try again") }
            }
        }
    }
}
