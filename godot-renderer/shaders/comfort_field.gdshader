// Comfort field over a room's floor: where it is cooler or warmer than the occupant's target, where the air is
// cleaner, and the air moving out of the AC and the purifier. Sources come from the platform's comfort model
// (web/lib/experience/comfort.ts). Works in Forward+ and GL Compatibility (web).
shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_never, blend_mix;

uniform vec4 src[8];          // x, z (metres), strength 0..1, kind (0 cool, 1 warm, 2 clean, 3 daylight, 4 light, 5 noise)
uniform int count = 0;
uniform float delta = 0.0;    // room temperature minus target, °C
uniform float air = 0.0;      // 0 clean .. 1 poor
uniform float score = 1.0;    // overall comfort 0..1
uniform int metric = 0;       // 0 thermal, 1 air, 2 overall score
uniform float alpha = 0.62;
uniform float reveal = 1.0;   // 0..1, grows out from the sources when the layer is switched on

varying vec3 wpos;

// smooth value noise: slow drifting air, so an even field still reads as air, not paint
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

// cool blue - teal - green (just right) - amber - red, for -3..+3 °C
vec3 thermal(float d) {
	float t = clamp(d / 2.5, -1.0, 1.0);
	vec3 cold = vec3(0.16, 0.42, 1.0), cool = vec3(0.1, 0.78, 0.86), ok = vec3(0.2, 0.82, 0.45), warm = vec3(1.0, 0.68, 0.16), hot = vec3(0.95, 0.25, 0.2);
	if (t < 0.0) return t < -0.5 ? mix(cool, cold, (-t - 0.5) * 2.0) : mix(ok, cool, -t * 2.0);
	return t > 0.5 ? mix(warm, hot, (t - 0.5) * 2.0) : mix(ok, warm, t * 2.0);
}

void fragment() {
	vec2 p = wpos.xz;
	float d = delta;
	float clean = 0.0;
	float flow = 0.0;
	float near = 0.0;
	for (int i = 0; i < 8; i++) {
		if (i >= count) break;
		vec4 s = src[i];
		float r = distance(p, s.xy);
		float k = s.w;
		float fall = exp(-r * r / 4.5);
		near = max(near, exp(-r * r / 6.0));
		if (k < 0.5) { d -= 3.6 * s.z * fall; flow += s.z * fall * (0.5 + 0.5 * sin(r * 7.0 - TIME * 2.6)); }
		else if (k < 1.5) { d += 1.6 * s.z * fall; flow += 0.6 * s.z * fall * (0.5 + 0.5 * sin(r * 6.0 - TIME * 1.4)); }
		else if (k < 2.5) { clean += s.z * exp(-r * r / 3.0); flow += 0.5 * s.z * fall * (0.5 + 0.5 * sin(r * 8.0 - TIME * 2.0)); }
	}
	vec3 c;
	if (metric == 1) {
		float q = clamp(air - clean * 0.6, 0.0, 1.0);
		c = mix(vec3(0.25, 0.75, 1.0), vec3(0.85, 0.55, 0.2), q);
	} else if (metric == 2) {
		c = thermal((1.0 - score) * 4.0);
	} else {
		c = thermal(d);
	}
	c += vec3(0.35) * flow;
	float drift = vnoise(p * 0.9 + vec2(TIME * 0.15, TIME * 0.07)) * 0.6 + vnoise(p * 2.3 - vec2(TIME * 0.1, 0.0)) * 0.4;
	c *= 0.86 + 0.28 * drift;
	// soft, slow breathing so the field reads as air, not paint
	float breathe = 0.9 + 0.1 * sin(TIME * 0.8 + p.x * 0.4 + p.y * 0.3);
	float a = alpha * breathe * (0.75 + 0.25 * near);
	// the layer grows out from the sources when switched on
	a *= smoothstep(0.0, 0.35, reveal - (1.0 - near) * 0.6);
	ALBEDO = c;
	ALPHA = clamp(a, 0.0, 0.85);
}
