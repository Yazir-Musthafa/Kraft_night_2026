package com.cher.watch.ui.widgets

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.min
import kotlin.math.pow

/** Ripples spreading out from a glowing disc with an icon: "alerting / searching" without any text. */
class PulseView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val dp = resources.displayMetrics.density

    var color: Int = 0xFFFF453A.toInt()
        set(v) { field = v; rebuild(); invalidate() }
    var icon: Drawable? = null
        set(v) { field = v?.mutate(); invalidate() }
    var rings: Int = 3
    /** Disc radius as a share of the view's half-size. */
    var discShare: Float = 0.34f
    var periodMs: Long = 2600
        set(v) { field = v; animator?.duration = v }
    /** Draw the disc + icon (false = only the ripples, used as an ambient background). */
    var showDisc: Boolean = true

    private val ripple = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG)
    private var phase = 0f
    private var animator: ValueAnimator? = null

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        rebuild()
    }

    private fun rebuild() {
        if (width == 0) return
        val r = min(width, height) / 2f * discShare
        val light = blend(color, 0xFFFFFFFF.toInt(), 0.25f)
        disc.shader = RadialGradient(width / 2f, height / 2f - r * 0.25f, r * 1.3f, light, color, Shader.TileMode.CLAMP)
    }

    private fun blend(a: Int, b: Int, t: Float): Int {
        fun ch(shift: Int) = (((a shr shift) and 0xFF) * (1 - t) + ((b shr shift) and 0xFF) * t).toInt()
        return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        update()
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); update() }
    override fun onDetachedFromWindow() { animator?.cancel(); animator = null; super.onDetachedFromWindow() }

    private fun update() {
        val need = isAttachedToWindow && isShown
        if (need && animator == null) {
            animator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = periodMs
                repeatCount = ValueAnimator.INFINITE
                interpolator = LinearInterpolator()
                addUpdateListener { phase = it.animatedValue as Float; invalidate() }
                start()
            }
        } else if (!need) {
            animator?.cancel(); animator = null
        }
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val half = min(width, height) / 2f
        val r0 = half * discShare
        for (i in 0 until rings) {
            val p = (phase + i.toFloat() / rings) % 1f
            val r = r0 + p * (half - r0)
            val a = ((1f - p).pow(1.6f) * 120).toInt()
            fill.color = (color and 0x00FFFFFF) or ((a / 5) shl 24)
            canvas.drawCircle(cx, cy, r, fill)
            ripple.strokeWidth = 1.5f * dp
            ripple.color = (color and 0x00FFFFFF) or (a shl 24)
            canvas.drawCircle(cx, cy, r, ripple)
        }
        if (showDisc) {
            canvas.drawCircle(cx, cy, r0, disc)
            icon?.let {
                val s = (r0 * 1.05f).toInt()
                it.setBounds((cx - s / 2f).toInt(), (cy - s / 2f).toInt(), (cx + s / 2f).toInt(), (cy + s / 2f).toInt())
                it.draw(canvas)
            }
        }
    }
}
