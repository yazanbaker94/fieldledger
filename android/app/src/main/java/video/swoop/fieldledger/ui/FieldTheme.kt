package video.swoop.fieldledger.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object FieldPalette {
    val Canvas = Color(0xFFECEAE2)
    val Paper = Color(0xFFFAF8F0)
    val Ink = Color(0xFF242C28)
    val Muted = Color(0xFF585E52)
    val Forest = Color(0xFF252D2A)
    val Copper = Color(0xFF87512F)
    val Rule = Color(0xFFD4D1C4)
    val CopperWash = Color(0xFFF1E4D2)
    val LightInk = Color(0xFFFFF9ED)
    val LightMuted = Color(0xFFCAD3C7)
    val CopperLight = Color(0xFFF0BD93)
    val Approved = Color(0xFF375C45)
    val Returned = Color(0xFF863E30)
}

private val FieldColors = lightColorScheme(
    primary = FieldPalette.Forest,
    onPrimary = FieldPalette.LightInk,
    secondary = FieldPalette.Copper,
    onSecondary = Color.White,
    secondaryContainer = FieldPalette.CopperWash,
    onSecondaryContainer = FieldPalette.Ink,
    background = FieldPalette.Canvas,
    onBackground = FieldPalette.Ink,
    surface = FieldPalette.Paper,
    onSurface = FieldPalette.Ink,
    surfaceVariant = Color(0xFFF0EDE3),
    onSurfaceVariant = FieldPalette.Muted,
    surfaceContainer = Color(0xFFF2EFE5),
    surfaceContainerHigh = Color(0xFFEDE9DD),
    outline = Color(0xFF837F71),
    outlineVariant = FieldPalette.Rule,
    error = FieldPalette.Returned,
    errorContainer = Color(0xFFF7E3DB),
    onErrorContainer = Color(0xFF682D24),
)

private fun editorial(size: Int, height: Int) = TextStyle(
    fontFamily = FontFamily.Serif,
    fontWeight = FontWeight.Normal,
    fontSize = size.sp,
    lineHeight = height.sp,
    letterSpacing = (-0.8).sp,
)

private val FieldType = Typography(
    displayLarge = editorial(52, 57),
    displayMedium = editorial(42, 48),
    displaySmall = editorial(36, 42),
    headlineLarge = editorial(34, 39),
    headlineMedium = editorial(29, 35),
    headlineSmall = editorial(25, 31),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 19.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.SemiBold),
)

@Composable
fun FieldTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = FieldColors,
        typography = FieldType,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(4.dp),
            small = RoundedCornerShape(6.dp),
            medium = RoundedCornerShape(8.dp),
            large = RoundedCornerShape(12.dp),
            extraLarge = RoundedCornerShape(16.dp),
        ),
        content = content,
    )
}
