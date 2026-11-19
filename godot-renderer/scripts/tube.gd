class_name Tube
## Builds a pipe along a polyline out of cylinder segments with the pipe_flow shader.
## Returns the segment materials so callers can change speed, colour and glow live.

const SHADER := preload("res://shaders/pipe_flow.gdshader")


static func build(parent: Node3D, pts: Array, color: Color, radius := 0.025, dash := 0.35) -> Array:
	var mats: Array = []
	var run := 0.0
	for k in range(pts.size() - 1):
		var a: Vector3 = pts[k]
		var b: Vector3 = pts[k + 1]
		var len := a.distance_to(b)
		if len < 0.005:
			continue
		var m := MeshInstance3D.new()
		var cm := CylinderMesh.new()
		cm.top_radius = radius
		cm.bottom_radius = radius
		cm.height = len
		cm.radial_segments = 10
		cm.rings = 1
		m.mesh = cm
		var mat := ShaderMaterial.new()
		mat.shader = SHADER
		mat.set_shader_parameter("base_color", color)
		mat.set_shader_parameter("seg_len", len)
		mat.set_shader_parameter("offset", run)
		mat.set_shader_parameter("dash", dash)
		m.material_override = mat
		parent.add_child(m)
		# Align the cylinder's Y axis from a to b. UV.y = 0 is the top (b), so positive speed flows a -> b.
		var y := (b - a).normalized()
		var x := y.cross(Vector3.FORWARD if absf(y.dot(Vector3.FORWARD)) < 0.9 else Vector3.RIGHT).normalized()
		m.global_transform = Transform3D(Basis(x, y, x.cross(y).normalized()).orthonormalized(), (a + b) / 2)
		run += len
		mats.append(mat)
	return mats


## Points on a quadratic curve from a to b bending through `ctrl`.
static func arc(a: Vector3, b: Vector3, ctrl: Vector3, steps := 8) -> Array:
	var pts: Array = []
	for i in steps + 1:
		var t := float(i) / steps
		pts.append(a.lerp(ctrl, t).lerp(ctrl.lerp(b, t), t))
	return pts
