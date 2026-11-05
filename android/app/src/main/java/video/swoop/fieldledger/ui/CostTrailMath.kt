package video.swoop.fieldledger.ui

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToLong

internal data class CostWindow(val start: Long, val end: Long) {
    fun fraction(cents: Long): Float =
        ((cents - start).toDouble() / (end - start)).coerceIn(0.0, 1.0).toFloat()

    operator fun contains(cents: Long): Boolean = cents in start..end
}

internal fun costWindow(before: Long, after: Long, budget: Long): CostWindow {
    val amount = (after - before).coerceAtLeast(0)
    val distance = when {
        budget < before -> before - budget
        budget > after -> budget - after
        else -> 0
    }
    // Keep the posting legible when an older entry is far away from the current budget line.
    val includeBudget = amount == 0L || distance <= maxOf(amount * 4, budget / 5)
    val low = if (includeBudget) minOf(before, budget) else before
    val high = if (includeBudget) maxOf(after, budget) else after
    val rough = maxOf((high - low) / 4.0, if (includeBudget) budget * .02 else 0.0, 1.0)
    val place = 10.0.pow(floor(log10(rough)))
    val step = (listOf(1, 2, 5, 10).first { it * place >= rough } * place).roundToLong()
    return CostWindow(
        start = (low / step * step - 3 * step).coerceAtLeast(0),
        end = (high / step + 1) * step,
    )
}

internal data class CostLayer(val from: Long, val to: Long)

internal fun costLayers(before: Long, after: Long, hours: Double, rate: Long?): List<CostLayer> {
    if (after <= before) return emptyList()
    if (rate == null || rate <= 0 || !hours.isFinite() || hours <= 0) {
        return listOf(CostLayer(before, after))
    }
    val count = ceil(hours).toInt().coerceIn(1, 24)
    return (0 until count).mapNotNull { index ->
        val from = before + index * rate
        val to = if (index == count - 1) after else minOf(after, from + rate)
        if (from < to) CostLayer(from, to) else null
    }
}

internal fun postingFrame(before: Long, after: Long, budget: Long, fraction: Float): Long {
    if (fraction <= .16f) return before
    if (fraction >= 1f) return after
    val quantum = if (before % 100 == 0L && after % 100 == 0L && budget % 100 == 0L) 100 else 1
    fun frame(start: Long, end: Long, t: Float): Long {
        val p = t.coerceIn(0f, 1f).toDouble()
        val eased = p * p * (3 - 2 * p)
        return ((start + (end - start) * eased) / quantum).roundToLong() * quantum
    }
    if (budget !in (before + 1) until after) {
        return frame(before, after, (fraction - .16f) / .84f)
    }
    return when {
        fraction < .64f -> frame(before, budget, (fraction - .16f) / .48f).coerceAtMost(budget - quantum)
        fraction < .76f -> budget
        else -> frame(budget, after, (fraction - .76f) / .24f).coerceAtLeast(budget + quantum)
    }
}
