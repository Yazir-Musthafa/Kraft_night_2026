package com.cher.watch.ui.widgets

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import com.cher.watch.utils.Geo
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * "Which way?" — a compass dial with a big arrow pointing at the person.
 * With a compass reading the dial turns so the arrow is relative to where the wearer faces (arrow up = straight ahead).
 * Without one (no sensor) the dial stays north-up and the arrow shows the true bearing; the UI says so.
 */
class DirectionView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val dp = resources.displayMetrics.density

    /** Bearing from the wearer to the person, degrees clockwise from north; null until both positions are known. */
    var bearing: Double? = null
        set(v) { field = v; invalidate() }
    /** The way the wearer faces (compass), or null. */
    var heading: Double? = null
        set(v) { field = v; invalidate() }
    /** Within a few steps of the person. */
    var close: Boolean = false
        set(v) { field = v; update(); invalidate() }
    var accent: Int = 0xFF4DA3FF.toInt()
        set(v) { field = v; invalidate() }
    var closeColor: Int = 0xFF32D74B.toInt()

    private val tick = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }
    private val letter = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    private val arrowFill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val arrowGlow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val arrow = Path()
    private var phase = 0f
    private var animator: ValueAnimator? = null

    override fun onVisibilityAggregated(isVisible: Boolean) { super.onVisibilityAggregated(isVisible); update() }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); update() }
    override fun onDetachedFromWindow() { animator?.cancel(); animator = null; super.onDetachedFromWindow() }

    private fun update() {
        val need = close && isAttachedToWindow && isShown
        if (need && animator == null) {
            animator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1600; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
                addUpdateListener { phase = it.animatedValue as Float; invalidate() }
                start()
            }
        } else if (!need) { animator?.cancel(); animator = null }
    }

    private fun polar(cx: Float, cy: Float, r: Float, deg: Double): Pair<Float, Float> {
        val a = deg * PI / 180.0
        return (cx + r * sin(a)).toFloat() to (cy - r * cos(a)).toFloat()
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height * 0.35f
        val ring = width * 0.295f
        val turn = heading ?: 0.0 // dial rotation: what is "up"

        // dial ticks + cardinal letters
        for (a in 0 until 360 step 6) {
            val major = a % 90 == 0
            val mid = a % 30 == 0
            if (major) continue
            val len = (if (mid) 8f else 4f) * dp
            val (x1, y1) = polar(cx, cy, ring, a - turn)
            val (x2, y2) = polar(cx, cy, ring - len, a - turn)
            tick.strokeWidth = (if (mid) 2f else 1.2f) * dp
            tick.color = if (mid) 0x66FFFFFF else 0x33FFFFFF
            canvas.drawLine(x1, y1, x2, y2, tick)
        }
        letter.textSize = 13f * dp
        for ((i, name) in arrayOf("N", "E", "S", "W").withIndex()) {
            val (x, y) = polar(cx, cy, ring - 11f * dp, i * 90.0 - turn)
            letter.color = if (i == 0) 0xFFFF453A.toInt() else 0x99FFFFFF.toInt()
            canvas.drawText(name, x, y + letter.textSize * 0.36f, letter)
        }

        val b = bearing
        if (close) {
            // arrived: a calm green pulse instead of an arrow
            val r = ring * 0.52f
            dot.color = (closeColor and 0x00FFFFFF) or (((1f - phase) * 70).toInt() shl 24)
            canvas.drawCircle(cx, cy, r * (1f + 0.35f * phase), dot)
            dot.color = closeColor
            canvas.drawCircle(cx, cy, r, dot)
            tick.color = 0xFF04210C.toInt()
            tick.strokeWidth = 5f * dp
            tick.style = Paint.Style.STROKE
            val s = r * 0.5f
            canvas.drawLine(cx - s * 0.7f, cy + s * 0.05f, cx - s * 0.15f, cy + s * 0.6f, tick)
            canvas.drawLine(cx - s * 0.15f, cy + s * 0.6f, cx + s * 0.8f, cy - s * 0.55f, tick)
            return
        }
        if (b == null) return

        val angle = (b - turn).toFloat()
        // waypoint dot on the dial
        val (dx, dy) = polar(cx, cy, ring, b - turn)
        dot.color = 0xFFFF453A.toInt()
        canvas.drawCircle(dx, dy, 5f * dp, dot)

        // big arrow (points up in local space, then rotated)
        val len = ring * 0.66f
        val wing = len * 0.52f
        arrow.reset()
        arrow.moveTo(0f, -len)
        arrow.lineTo(wing, len * 0.62f)
        arrow.lineTo(0f, len * 0.30f)
        arrow.lineTo(-wing, len * 0.62f)
        arrow.close()
        val save = canvas.save()
        canvas.translate(cx, cy)
        canvas.rotate(angle)
        arrowGlow.color = accent
        arrowGlow.strokeWidth = 14f * dp; arrowGlow.alpha = 26
        canvas.drawPath(arrow, arrowGlow)
        arrowGlow.strokeWidth = 8f * dp; arrowGlow.alpha = 46
        canvas.drawPath(arrow, arrowGlow)
        arrowFill.shader = LinearGradient(0f, -len, 0f, len * 0.62f, 0xFF9AD6FF.toInt(), accent, Shader.TileMode.CLAMP)
        canvas.drawPath(arrow, arrowFill)
        canvas.restoreToCount(save)
    }
}
