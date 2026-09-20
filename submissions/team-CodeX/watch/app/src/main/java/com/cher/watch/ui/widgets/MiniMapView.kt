package com.cher.watch.ui.widgets

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import com.cher.watch.ui.models.GeoPoint
import com.cher.watch.utils.Geo
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

/**
 * A vector mini-map drawn on the watch itself (no map SDK, no tiles, works offline): range rings with a scale, the
 * wearer with a heading cone and breadcrumb trail, the person as a pulsing red marker, and the straight line between
 * them. Zoom auto-fits both. North is up, or the wearer's heading is up when the compass is available.
 */
class MiniMapView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val dp = resources.displayMetrics.density

    var own: GeoPoint? = null
        set(v) { field = v; invalidate() }
    var target: GeoPoint? = null
        set(v) { field = v; invalidate() }
    var trail: List<GeoPoint> = emptyList()
        set(v) { field = v; invalidate() }
    var heading: Double? = null
        set(v) { field = v; invalidate() }
    var accent: Int = 0xFF4DA3FF.toInt()
    var danger: Int = 0xFFFF453A.toInt()

    private val bg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    private val path = Path()
    private var phase = 0f
    private var animator: ValueAnimator? = null

    override fun onVisibilityAggregated(isVisible: Boolean) { super.onVisibilityAggregated(isVisible); update() }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); update() }
    override fun onDetachedFromWindow() { animator?.cancel(); animator = null; super.onDetachedFromWindow() }

    private fun update() {
        val need = isAttachedToWindow && isShown
        if (need && animator == null) {
            animator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1800; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
                addUpdateListener { phase = it.animatedValue as Float; invalidate() }
                start()
            }
        } else if (!need) { animator?.cancel(); animator = null }
    }

    private val niceRanges = doubleArrayOf(25.0, 50.0, 100.0, 200.0, 500.0, 1_000.0, 2_000.0, 5_000.0, 10_000.0, 20_000.0, 50_000.0)

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val radius = width * 0.44f

        // map disc
        bg.shader = RadialGradient(cx, cy, radius, 0xFF10151F.toInt(), 0xFF070A10.toInt(), Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, radius, bg)
        stroke.style = Paint.Style.STROKE
        stroke.strokeWidth = 1.5f * dp
        stroke.color = 0xFF2A3245.toInt()
        canvas.drawCircle(cx, cy, radius, stroke)

        val o = own
        val t = target
        // world frame: origin = midpoint of the two positions so both fit
        val mid = when {
            o != null && t != null -> GeoPoint((o.latitude + t.latitude) / 2, (o.longitude + t.longitude) / 2)
            o != null -> o
            t != null -> t
            else -> null
        }
        val turn = heading ?: 0.0

        fun toScreen(p: GeoPoint, scale: Float): Pair<Float, Float> {
            val (e, n) = Geo.eastNorthM(mid!!.latitude, mid.longitude, p.latitude, p.longitude)
            val a = -turn * PI / 180.0
            val x = e * cos(a) - n * sin(a)
            val y = e * sin(a) + n * cos(a)
            return (cx + x * scale).toFloat() to (cy - y * scale).toFloat()
        }

        if (mid == null) {
            text.color = 0x99FFFFFF.toInt(); text.textSize = 12f * dp
            canvas.drawText("Waiting for GPS…", cx, cy, text)
            return
        }

        val span = if (o != null && t != null) Geo.distanceM(o.latitude, o.longitude, t.latitude, t.longitude) else 0.0
        val fitM = max(span / 2 * 1.3, 30.0)
        val range = niceRanges.firstOrNull { it >= fitM } ?: niceRanges.last()
        val scale = (radius / range).toFloat()

        // range rings + grid
        stroke.color = 0x22FFFFFF
        stroke.strokeWidth = 1f * dp
        canvas.drawLine(cx - radius, cy, cx + radius, cy, stroke)
        canvas.drawLine(cx, cy - radius, cx, cy + radius, stroke)
        for (f in doubleArrayOf(0.5, 1.0)) {
            if (f == 1.0) continue
            canvas.drawCircle(cx, cy, (radius * f).toFloat(), stroke)
        }
        text.color = 0x88FFFFFF.toInt(); text.textSize = 9.5f * dp
        canvas.drawText(Geo.formatDistance(range), cx + radius * 0.62f, cy + radius * 0.80f, text)

        // north badge (rotates with the map)
        run {
            val a = -turn * PI / 180.0
            val nx = cx + (radius - 9 * dp) * sin(a).toFloat()
            val ny = cy - (radius - 9 * dp) * cos(a).toFloat()
            text.color = danger; text.textSize = 11f * dp
            canvas.drawText("N", nx, ny + 4 * dp, text)
        }

        // trail
        if (trail.size >= 2) {
            path.reset()
            trail.forEachIndexed { i, p ->
                val (x, y) = toScreen(p, scale)
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            stroke.color = (accent and 0x00FFFFFF) or (0x88 shl 24)
            stroke.strokeWidth = 2.5f * dp
            canvas.drawPath(path, stroke)
        }

        // straight line own -> target
        if (o != null && t != null) {
            val (ox, oy) = toScreen(o, scale)
            val (tx, ty) = toScreen(t, scale)
            stroke.color = 0xAAFFFFFF.toInt()
            stroke.strokeWidth = 1.6f * dp
            stroke.pathEffect = DashPathEffect(floatArrayOf(6f * dp, 5f * dp), 0f)
            canvas.drawLine(ox, oy, tx, ty, stroke)
            stroke.pathEffect = null
        }

        // person: accuracy disc, pulsing halo, marker
        if (t != null) {
            val (tx, ty) = toScreen(t, scale)
            val acc = ((t.accuracy ?: 0f) * scale).coerceIn(0f, radius * 0.5f)
            if (acc > 6 * dp) { fill.color = (danger and 0x00FFFFFF) or (0x22 shl 24); canvas.drawCircle(tx, ty, acc, fill) }
            fill.color = (danger and 0x00FFFFFF) or (((1f - phase) * 90).toInt() shl 24)
            canvas.drawCircle(tx, ty, (7f + 15f * phase) * dp, fill)
            fill.color = 0xFFFFFFFF.toInt(); canvas.drawCircle(tx, ty, 7.5f * dp, fill)
            fill.color = danger; canvas.drawCircle(tx, ty, 5.5f * dp, fill)
        }

        // wearer: heading cone + blue dot
        if (o != null) {
            val (ox, oy) = toScreen(o, scale)
            if (heading != null) {
                // heading-up map: "ahead" is straight up on screen
                path.reset()
                path.moveTo(ox, oy)
                path.lineTo(ox - 11 * dp, oy - 24 * dp)
                path.lineTo(ox + 11 * dp, oy - 24 * dp)
                path.close()
                fill.shader = android.graphics.LinearGradient(ox, oy, ox, oy - 24 * dp, (accent and 0x00FFFFFF) or (0x88 shl 24), accent and 0x00FFFFFF, Shader.TileMode.CLAMP)
                canvas.drawPath(path, fill)
                fill.shader = null
            }
            fill.color = 0xFFFFFFFF.toInt(); canvas.drawCircle(ox, oy, 7f * dp, fill)
            fill.color = accent; canvas.drawCircle(ox, oy, 5f * dp, fill)
        }

        if (o == null) {
            text.color = 0xCCFFB020.toInt(); text.textSize = 10.5f * dp
            canvas.drawText("Waiting for your GPS…", cx, cy + radius * 0.55f, text)
        }
        // the target may be off the edge when very far: hint the direction with an arrow at the rim
        if (o != null && t != null) {
            val (tx, ty) = toScreen(t, scale)
            if (hypot(tx - cx, ty - cy) > radius) {
                val ang = kotlin.math.atan2((ty - cy).toDouble(), (tx - cx).toDouble())
                fill.color = danger
                canvas.drawCircle((cx + (radius - 6 * dp) * cos(ang)).toFloat(), (cy + (radius - 6 * dp) * sin(ang)).toFloat(), 5 * dp, fill)
            }
        }
    }
}
