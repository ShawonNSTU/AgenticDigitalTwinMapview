// X-ray shell for an opened device: transparent body with a fresnel rim so internals stay readable.
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled;

uniform vec4 rim_color : source_color = vec4(0.45, 0.7, 1.0, 1.0);
uniform float strength = 0.9;

void fragment() {
	float f = pow(1.0 - abs(dot(normalize(NORMAL), normalize(VIEW))), 2.5);
	ALBEDO = rim_color.rgb * (0.06 + f * strength);
}
