package com.cher.watch.ui.widgets

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.core.graphics.PathParser

/** A heart that beats at the wearer's real heart rate. With no reading it stays still and dim: it never fakes a pulse. */
class HeartbeatView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val heart: Path = PathParser.createPathFromPathData(
        "M12,21.35l-1.45,-1.32C5.4,15.36 2,12.28 2,8.5 2,5.42 4.42,3 7.5,3c1.74,0 3.41,0.81 4.5,2.09C13.09,3.81 14.76,3 16.5,3 19.58,3 22,5.42 22,8.5c0,3.78 -3.4,6.86 -8.55,11.54L12,21.35z",
    )
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val matrixTmp = android.graphics.Matrix()
    private val out = Path()
    private var scale = 1f
    private var beat: ValueAnimator? = null
    private var bpm: Int? = null
    private var lit = false

    var color: Int = 0xFFFF453A.toInt()
        set(v) { field = v; invalidate() }

    fun setBpm(value: Int?) {
        if (value == bpm) return
        bpm = value
        lit = value != null
        restart()
        invalidate()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) { super.onVisibilityAggregated(isVisible); restart() }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); restart() }
    override fun onDetachedFromWindow() { beat?.cancel(); beat = null; super.onDetachedFromWindow() }

    private fun restart() {
        beat?.cancel()
        beat = null
        val b = bpm
        if (b == null || b <= 0 || !isAttachedToWindow || !isShown) { scale = 1f; return }
        val period = (60_000L / b).coerceIn(300L, 2_000L)
        // lub-dub: two quick swells, then rest for the remainder of the beat
        beat = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = period
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener {
                val t = it.animatedValue as Float
                scale = 1f + when {
                    t < 0.12f -> 0.22f * (t / 0.12f)
                    t < 0.24f -> 0.22f * (1 - (t - 0.12f) / 0.12f)
                    t < 0.36f -> 0.14f * ((t - 0.24f) / 0.12f)
                    t < 0.5f -> 0.14f * (1 - (t - 0.36f) / 0.14f)
                    else -> 0f
                }
                invalidate()
            }
            interpolator = DecelerateInterpolator(0.4f)
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        val s = minOf(width, height) / 24f
        matrixTmp.reset()
        matrixTmp.postScale(s * scale, s * scale)
        matrixTmp.postTranslate(width / 2f - 12f * s * scale, height / 2f - 12f * s * scale)
        heart.transform(matrixTmp, out)
        paint.color = if (lit) color else (color and 0x00FFFFFF) or (0x55 shl 24)
        canvas.drawPath(out, paint)
    }
}
