class_name Beads
extends MultiMeshInstance3D
## Glowing beads that travel along polylines: the flow made visible. Each line has its own speed (m/s,
## negative = reverse), set from live readings; one MultiMesh draws every bead of one colour.

var _lines: Array = []   # {pts, cum, len, speed, phase, n}
var _radius := 0.03


func setup(color: Color, radius: float) -> Beads:
	_radius = radius
	var sm := SphereMesh.new()
	sm.radius = 0.5
	sm.height = 1.0
	sm.radial_segments = 10
	sm.rings = 5
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = color.lightened(0.35)
	multimesh = MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.mesh = sm
	material_override = m
	return self


## Adds a line; beads are spaced about `spacing` metres apart. Returns its index for set_speed().
func add_line(pts: Array, spacing := 0.35) -> int:
	var cum := PackedFloat32Array([0.0])
	for i in range(1, pts.size()):
		cum.append(cum[-1] + (pts[i] as Vector3).distance_to(pts[i - 1]))
	var total: float = cum[-1]
	_lines.append({"pts": pts, "cum": cum, "len": total, "speed": 0.0, "phase": randf() * total, "n": maxi(2, int(total / spacing)), "on": true})
	var count := 0
	for l in _lines:
		count += l.n
	multimesh.instance_count = count
	return _lines.size() - 1


func set_speed(i: int, v: float) -> void:
	if i >= 0 and i < _lines.size():
		_lines[i].speed = v


## Shows or hides one line's beads.
func set_line_visible(i: int, on: bool) -> void:
	if i >= 0 and i < _lines.size():
		_lines[i].on = on


func _process(delta: float) -> void:
	var idx := 0
	for l in _lines:
		l.phase = fposmod(l.phase + l.speed * delta, maxf(l.len, 0.001))
		for k in l.n:
			var s := fposmod(l.phase + k * l.len / l.n, maxf(l.len, 0.001))
			var scale := (_radius * (1.0 if absf(l.speed) > 0.001 else 0.6)) if l.on else 0.0
			multimesh.set_instance_transform(idx, Transform3D(Basis.from_scale(Vector3.ONE * scale * 2.0), _at(l, s)))
			idx += 1


func _at(l: Dictionary, s: float) -> Vector3:
	var cum: PackedFloat32Array = l.cum
	var pts: Array = l.pts
	var i := cum.bsearch(s)
	i = clampi(i, 1, pts.size() - 1)
	var seg := cum[i] - cum[i - 1]
	var f := 0.0 if seg <= 0.0 else (s - cum[i - 1]) / seg
	return (pts[i - 1] as Vector3).lerp(pts[i], f)
