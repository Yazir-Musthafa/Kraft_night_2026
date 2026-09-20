package com.cher.watch.ui.emergency

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.animation.LinearInterpolator
import android.widget.Button
import com.cher.watch.utils.CherConfig

/**
 * Press-and-hold button (manual SOS). A progress bar fills while held; letting go early cancels.
 * Deliberately hard to trigger by accident, but always available and needing no detection to succeed.
 */
class HoldButton @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : Button(context, attrs) {
    var holdMs: Long = CherConfig.MANUAL_SOS_HOLD_MS
    var onHoldComplete: (() -> Unit)? = null
    var onHoldTooShort: (() -> Unit)? = null

    private var progress = 0f
    private var animator: ValueAnimator? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x66FFFFFF }
    private val rect = RectF()

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                isPressed = true
                startHold()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                isPressed = false
                val completed = progress >= 1f
                stopHold()
                if (!completed && event.actionMasked == MotionEvent.ACTION_UP) {
                    performClick()
                    onHoldTooShort?.invoke()
                }
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun startHold() {
        stopHold()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = holdMs
            interpolator = LinearInterpolator()
            addUpdateListener {
                progress = it.animatedValue as Float
                invalidate()
                if (progress >= 1f) {
                    stopHoldKeepingProgress()
                    performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                    onHoldComplete?.invoke()
                    progress = 0f
                    invalidate()
                }
            }
            start()
        }
    }

    private fun stopHoldKeepingProgress() {
        animator?.removeAllUpdateListeners()
        animator?.cancel()
        animator = null
    }

    private fun stopHold() {
        stopHoldKeepingProgress()
        progress = 0f
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (progress > 0f) {
            rect.set(0f, 0f, width * progress, height.toFloat())
            val save = canvas.save()
            canvas.clipRect(rect)
            canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), height / 2f, height / 2f, paint)
            canvas.restoreToCount(save)
        }
    }
}
