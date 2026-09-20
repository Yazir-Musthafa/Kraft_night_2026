package com.cher.watch.ui.widgets

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import kotlin.math.abs

/**
 * Minimal horizontal pager for a round screen: children are the pages; swipe or turn the rotary crown to switch.
 * Page dots sit on the lower arc. Only the current page is visible (cross-fade), so nothing draws off-screen.
 */
class SwipePager @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : FrameLayout(context, attrs) {
    private val dp = resources.displayMetrics.density
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private var downX = 0f
    private var downY = 0f
    private var swiping = false

    var page: Int = 0
        private set
    var onPageChanged: ((Int) -> Unit)? = null

    init {
        setWillNotDraw(false)
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onFinishInflate() {
        super.onFinishInflate()
        for (i in 0 until childCount) getChildAt(i).apply { visibility = if (i == 0) VISIBLE else GONE; alpha = 1f }
    }

    fun setPage(index: Int, animate: Boolean = true) {
        val target = index.coerceIn(0, (childCount - 1).coerceAtLeast(0))
        if (target == page && getChildAt(target)?.visibility == VISIBLE) return
        val from = getChildAt(page)
        val to = getChildAt(target) ?: return
        page = target
        for (i in 0 until childCount) if (i != target && getChildAt(i) !== from) getChildAt(i).visibility = GONE
        to.alpha = if (animate) 0f else 1f
        to.visibility = VISIBLE
        if (animate) {
            to.animate().alpha(1f).setDuration(180).start()
            if (from !== to) from?.animate()?.alpha(0f)?.setDuration(140)?.withEndAction { if (from !== getChildAt(page)) from.visibility = GONE; from.alpha = 1f }?.start()
        } else if (from !== to) from?.visibility = GONE
        invalidate()
        onPageChanged?.invoke(target)
    }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downX = ev.x; downY = ev.y; swiping = false }
            MotionEvent.ACTION_MOVE -> {
                val dx = ev.x - downX
                if (!swiping && abs(dx) > slop * 1.5f && abs(dx) > abs(ev.y - downY) * 1.3f) {
                    swiping = true
                    parent?.requestDisallowInterceptTouchEvent(true)
                }
            }
        }
        return swiping
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downX = ev.x; downY = ev.y; swiping = false }
            MotionEvent.ACTION_MOVE -> {
                val dx = ev.x - downX
                if (!swiping && abs(dx) > slop * 1.5f && abs(dx) > abs(ev.y - downY) * 1.3f) swiping = true
            }
            MotionEvent.ACTION_UP -> {
                if (swiping) {
                    val dx = ev.x - downX
                    if (abs(dx) > 28 * dp) setPage(if (dx < 0) page + 1 else page - 1)
                    swiping = false
                }
            }
            MotionEvent.ACTION_CANCEL -> swiping = false
        }
        return true
    }

    override fun onGenericMotionEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_SCROLL && ev.isFromSource(InputDevice.SOURCE_ROTARY_ENCODER)) {
            val delta = ev.getAxisValue(MotionEvent.AXIS_SCROLL)
            if (abs(delta) > 0.01f) { setPage(if (delta < 0) page + 1 else page - 1); return true }
        }
        return super.onGenericMotionEvent(ev)
    }

    override fun dispatchDraw(canvas: Canvas) {
        super.dispatchDraw(canvas)
        val n = childCount
        if (n < 2) return
        val gap = 11 * dp
        val y = height - 13 * dp
        var x = width / 2f - gap * (n - 1) / 2f
        for (i in 0 until n) {
            dot.color = if (i == page) 0xFFFFFFFF.toInt() else 0x55FFFFFF
            canvas.drawCircle(x, y, (if (i == page) 3.2f else 2.4f) * dp, dot)
            x += gap
        }
    }
}
