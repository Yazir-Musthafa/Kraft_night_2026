package com.cher.watch.ui.widgets

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SweepGradient
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.sin

/**
 * The glowing ring that hugs the edge of a round screen. It carries status at a glance:
 *  - [progress]: an arc filling clockwise from 12 o'clock (countdowns, response coverage)
 *  - [breathe]: the whole ring slowly pulses (something is live)
 *  - [comet]: a bright arc circles the ring (searching / waiting)
 * Animation only runs while the view is actually on screen.
 */
class RingView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val dp = resources.displayMetrics.density

    var ringColor: Int = 0xFF32D74B.toInt()
        set(v) { if (field != v) { field = v; rebuildShader(); invalidate() } }
    var thicknessDp: Float = 5f
        set(v) { field = v; invalidate() }
    /** 0..1 clockwise from the top; null draws the full ring. */
    var progress: Float? = null
        set(v) { if (field != v) { field = v; invalidate() } }
    var breathe: Boolean = false
        set(v) { field = v; updateAnimator() }
    var comet: Boolean = false
        set(v) { field = v; updateAnimator() }

    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val rect = RectF()
    private var phase = 0f
    private var animator: ValueAnimator? = null
    private var cometShader: SweepGradient? = null

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        rebuildShader()
    }

    private fun rebuildShader() {
        if (width == 0) return
        val transparent = ringColor and 0x00FFFFFF
        cometShader = SweepGradient(width / 2f, height / 2f, intArrayOf(transparent, ringColor), floatArrayOf(0f, 0.3f))
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        updateAnimator()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        updateAnimator()
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        animator = null
        super.onDetachedFromWindow()
    }

    private fun updateAnimator() {
        val need = (breathe || comet) && isAttachedToWindow && isShown
        if (need && animator == null) {
            animator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = if (comet) 1800 else 2600
                repeatCount = ValueAnimator.INFINITE
                interpolator = LinearInterpolator()
                addUpdateListener { phase = it.animatedValue as Float; invalidate() }
                start()
            }
        } else if (!need) {
            animator?.cancel()
            animator = null
        }
    }

    private fun withAlpha(color: Int, a: Int) = (color and 0x00FFFFFF) or (a.coerceIn(0, 255) shl 24)

    override fun onDraw(canvas: Canvas) {
        val t = thicknessDp * dp
        val pad = t / 2 + 3 * dp
        rect.set(pad, pad, width - pad, height - pad)
        val pulse = if (breathe) (0.5f + 0.5f * sin(phase * 2 * PI).toFloat()) else 1f

        track.strokeWidth = t
        track.color = withAlpha(ringColor, 46)
        canvas.drawArc(rect, 0f, 360f, false, track)

        val p = progress
        if (p != null) {
            val sweep = 360f * p.coerceIn(0f, 1f)
            if (sweep > 0.5f) {
                drawGlowArc(canvas, -90f, sweep, t, 1f)
            }
        } else {
            val a = 0.55f + 0.45f * pulse
            drawGlowArc(canvas, 0f, 360f, t, a)
        }

        if (comet) {
            val shader = cometShader
            if (shader != null) {
                arc.shader = shader
                arc.strokeWidth = t
                arc.color = ringColor
                arc.alpha = 255
                val save = canvas.save()
                canvas.rotate(phase * 360f - 90f, width / 2f, height / 2f)
                canvas.drawArc(rect, 0f, 110f, false, arc)
                canvas.restoreToCount(save)
                arc.shader = null
            }
        }
    }

    /** Soft glow made from three widening, fainter strokes (cheap, hardware-accelerated). */
    private fun drawGlowArc(canvas: Canvas, start: Float, sweep: Float, t: Float, alphaScale: Float) {
        glow.color = ringColor
        glow.strokeWidth = t * 3.0f; glow.alpha = (20 * alphaScale).toInt()
        canvas.drawArc(rect, start, sweep, false, glow)
        glow.strokeWidth = t * 2.0f; glow.alpha = (38 * alphaScale).toInt()
        canvas.drawArc(rect, start, sweep, false, glow)
        arc.shader = null
        arc.color = ringColor
        arc.alpha = (255 * alphaScale).toInt()
        arc.strokeWidth = t
        canvas.drawArc(rect, start, sweep, false, arc)
    }
}
