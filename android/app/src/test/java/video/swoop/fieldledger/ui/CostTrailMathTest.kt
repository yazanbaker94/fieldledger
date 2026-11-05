package video.swoop.fieldledger.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CostTrailMathTest {
    @Test
    fun crossingUsesExactBudgetAndSettlesAtCommittedTotal() {
        val before = 970_000L
        val budget = 1_000_000L
        val after = 1_010_000L
        assertEquals(before, postingFrame(before, after, budget, 0f))
        assertTrue(postingFrame(before, after, budget, .63f) < budget)
        assertEquals(budget, postingFrame(before, after, budget, .65f))
        assertEquals(budget, postingFrame(before, after, budget, .75f))
        assertTrue(postingFrame(before, after, budget, .77f) > budget)
        assertEquals(after, postingFrame(before, after, budget, 1f))
    }

    @Test
    fun partialHourClosesAtPersistedRoundedCents() {
        val before = 970_000L
        val after = 1_010_050L
        val layers = costLayers(before, after, 8.01, 5_000)
        assertEquals(9, layers.size)
        assertEquals(5_000L, layers[0].to - layers[0].from)
        assertEquals(CostLayer(1_010_000, after), layers.last())
        assertEquals(after - before, layers.sumOf { it.to - it.from })
    }

    @Test
    fun rangeIncludesBudgetCrossingAndKeepsAnOlderPostingLegible() {
        val budget = 1_000_000L
        val latest = costWindow(970_000, 1_010_000, budget)
        assertTrue(budget in latest)
        assertTrue(latest.fraction(970_000) < latest.fraction(budget))
        assertTrue(latest.fraction(budget) < latest.fraction(1_010_000))

        val old = costWindow(0, 10_000, budget)
        assertTrue(0L in old)
        assertTrue(10_000L in old)
        assertFalse(budget in old)
    }
}
