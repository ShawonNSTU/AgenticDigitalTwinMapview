// Animated refrigerant flow along a pipe segment (CylinderMesh: UV.y runs along the length).
// Works in Forward+ and GL Compatibility (web).
shader_type spatial;
render_mode cull_back;

uniform vec4 base_color : source_color = vec4(0.25, 0.55, 1.0, 1.0);
uniform float seg_len = 1.0;      // metres, so dash spacing is the same on every segment
uniform float offset = 0.0;       // metres from the start of the whole run, keeps dashes continuous
uniform float speed = 0.6;        // metres per second; 0 = stopped, negative = reverse
uniform float dash = 0.35;        // dash spacing in metres
uniform float glow = 1.0;         // 1 normal, >1 traced, <1 dimmed

void fragment() {
	float s = offset + (1.0 - UV.y) * seg_len - TIME * speed;
	float d = smoothstep(0.35, 0.5, fract(s / dash)) * (1.0 - smoothstep(0.75, 0.9, fract(s / dash)));
	vec3 c = base_color.rgb;
	ALBEDO = c * 0.35;
	EMISSION = c * (0.25 + 1.6 * d) * glow;
	ROUGHNESS = 0.35;
	METALLIC = 0.6;
}
