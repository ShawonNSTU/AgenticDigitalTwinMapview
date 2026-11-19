class_name TwinPart
extends Node3D
## One internal component of a device twin: a recognisable 3D model built procedurally to fit its
## box (`size`, in twin-local metres), plus animations driven by live readings.
##
## Kinds (data/part_layout.json picks one per part): filter, coil, fan_cross, fan_axial, motor, sensor,
## louver, tray, pcb, radio, compressor, gauge, tank, valve, heatsink, led_disc, diffuser, panel, cone,
## dome, roller, battery, serpentine, button, heater, bin, lidar, lens, led_ring, bolt, keypad, pump,
## level_tube, drum, probe, relay, meter, hepa, pm.
##
## Params set by apply(): spin (rad/s), temp (°C → colour, frost below 3 °C), glow (0..1), level (0..1),
## open (0..1), dirt (0..1), pulse (0..1), angle (degrees), vibrate (0..1), active (0/1), wet (0/1), text.
## Changes are eased so readings that jump still animate smoothly.

const COPPER := Color(0.78, 0.47, 0.25)
const ALU := Color(0.82, 0.84, 0.87)
const STEEL := Color(0.55, 0.57, 0.6)
const WHITE := Color(0.93, 0.94, 0.95)
const DARK := Color(0.16, 0.17, 0.19)
const PCB := Color(0.1, 0.42, 0.24)
const WATER := Color(0.25, 0.65, 0.9, 0.55)

var kind := ""
var size := Vector3.ONE
var health := "ok"

var target := {"spin": 0.0, "temp": 22.0, "glow": 0.0, "level": 0.0, "open": 0.0, "dirt": 0.0, "pulse": 0.0, "angle": 0.0, "vibrate": 0.0, "active": 0.0, "wet": 0.0}
var cur := target.duplicate()
var _has_temp := false

var spinner: Node3D
var spin_axis := Vector3.UP
var temp_mats: Array = []
var glow_mats: Array = []
var glow_color := Color(1, 0.85, 0.5)
var fill: Node3D
var dirt_mat: StandardMaterial3D
var frost_mat: StandardMaterial3D
var hinges: Array = []
var needle: Node3D
var slider: Node3D
var slide_a := Vector3.ZERO
var slide_b := Vector3.ZERO
var rings: Array = []
var droplets: Node3D
var blink_mat: StandardMaterial3D
var text_label: Label3D
var vib: Node3D
var halo_mat: StandardMaterial3D
var _t := 0.0


func setup(k: String, s: Vector3) -> TwinPart:
	kind = k
	size = s
	vib = Node3D.new()
	add_child(vib)
	match kind:
		"filter": _filter()
		"coil": _coil()
		"fan_cross": _fan_cross()
		"fan_axial": _fan_axial()
		"motor": _motor()
		"sensor": _sensor()
		"louver": _louver()
		"tray": _tray()
		"pcb": _pcb()
		"radio": _radio()
		"compressor": _compressor()
		"gauge": _gauge()
		"tank": _tank()
		"valve": _valve()
		"heatsink": _heatsink()
		"led_disc": _led_disc()
		"diffuser": _diffuser()
		"panel": _panel()
		"cone": _cone()
		"dome": _dome()
		"roller": _roller()
		"battery": _battery()
		"serpentine": _serpentine()
		"button": _button()
		"heater": _heater()
		"bin": _bin()
		"lidar": _lidar()
		"lens": _lens()
		"led_ring": _led_ring()
		"bolt": _bolt()
		"keypad": _keypad()
		"pump": _pump()
		"level_tube": _level_tube()
		"drum": _drum()
		"probe": _probe()
		"relay": _relay()
		"meter": _meter()
		"hepa": _hepa()
		"pm": _pm()
		_: _box(size, Vector3.ZERO, _mat(WHITE))
	_halo()
	return self


## params: values computed from the readings; h: part health.
func apply(params: Dictionary, h: String, value_text := "") -> void:
	for k in params:
		if target.has(k):
			target[k] = float(params[k])
	if params.has("temp"):
		_has_temp = true
	if kind == "probe":
		target.dirt = target.wet * 0.7  # puddle under a wet probe
	if text_label and value_text != "":
		text_label.text = value_text
	health = h


func _process(delta: float) -> void:
	_t += delta
	var a := 1.0 - exp(-5.0 * delta)
	for k in cur:
		cur[k] = lerpf(cur[k], target[k], a)
	if spinner:
		spinner.rotate_object_local(spin_axis, cur.spin * delta)
	if vib:
		var amp: float = cur.vibrate * 0.012 * size.length()
		vib.position = Vector3(sin(_t * 97.0), sin(_t * 113.0 + 1.0), sin(_t * 89.0 + 2.0)) * amp
	if _has_temp:
		var c := temp_color(cur.temp)
		for m in temp_mats:
			m.albedo_color = Color(c, m.albedo_color.a)
			m.emission = c * 0.25
		if frost_mat:
			frost_mat.albedo_color.a = clampf((3.0 - cur.temp) / 6.0, 0.0, 0.75)
	for m in glow_mats:
		m.emission_energy_multiplier = clampf(cur.glow, 0.0, 1.5) * 3.0
	if fill:
		if kind == "pm":
			fill.scale = Vector3.ONE * (0.25 + clampf(cur.level, 0.0, 1.5))  # particle cloud density
		else:
			fill.scale.y = maxf(0.001, clampf(cur.level, 0.0, 1.0))
		if kind == "battery" and fill.has_meta("mat"):
			var bc := Color(0.97, 0.32, 0.29) if cur.level < 0.15 else (Color(0.82, 0.6, 0.13) if cur.level < 0.3 else Color(0.25, 0.75, 0.35))
			(fill.get_meta("mat") as StandardMaterial3D).albedo_color = bc
	if dirt_mat:
		dirt_mat.albedo_color.a = clampf(cur.dirt, 0.0, 1.0) * 0.85
	for hn in hinges:
		hn.rotation.x = deg_to_rad(cur.angle)
	if needle:
		needle.rotation.z = -deg_to_rad(clampf(cur.angle, 0.0, 270.0)) + deg_to_rad(135.0)
	if slider:
		slider.position = slide_a.lerp(slide_b, clampf(cur.open, 0.0, 1.0))
	for i in rings.size():
		var r: MeshInstance3D = rings[i]
		var ph := fmod(_t * (0.6 + cur.pulse * 1.4) + i / float(rings.size()), 1.0)
		r.scale = Vector3.ONE * (0.4 + ph * 1.2)
		(r.material_override as StandardMaterial3D).albedo_color.a = (1.0 - ph) * clampf(cur.pulse, 0.0, 1.0) * 0.8
	if droplets:
		droplets.visible = cur.wet > 0.5
		for d in droplets.get_children():
			d.position.y = -fmod(_t * 0.6 + d.get_meta("ph", 0.0), 1.0) * size.y * 0.8
	if blink_mat:
		var on: bool = cur.active > 0.5 and fmod(_t, 1.0) < 0.5
		blink_mat.emission_energy_multiplier = 4.0 if on else 0.2
	if halo_mat:
		var col: Color = {"watch": Color(0.82, 0.6, 0.13), "fault": Color(0.97, 0.32, 0.29)}.get(health, Color(0, 0, 0))
		var pulse := 0.5 + 0.5 * sin(_t * (6.0 if health == "fault" else 2.5))
		halo_mat.albedo_color = Color(col, (0.18 + 0.22 * pulse) if health != "ok" else 0.0)


static func temp_color(t: float) -> Color:
	var stops := [[-20.0, Color("cfe8ff")], [0.0, Color("4c8dff")], [15.0, Color("3fc1c9")], [30.0, Color("9bd36a")], [50.0, Color("ffd34d")], [80.0, Color("ff8a3d")], [110.0, Color("f85149")]]
	if t <= stops[0][0]:
		return stops[0][1]
	for i in range(1, stops.size()):
		if t <= stops[i][0]:
			var f: float = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])
			return (stops[i - 1][1] as Color).lerp(stops[i][1], f)
	return stops[-1][1]


# ---------------------------------------------------------------- helpers

func _mat(c: Color, metal := 0.0, rough := 0.5) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	m.metallic = metal
	m.roughness = rough
	if c.a < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return m


func _glow_mat(c: Color) -> StandardMaterial3D:
	var m := _mat(c)
	m.emission_enabled = true
	m.emission = c
	m.emission_energy_multiplier = 0.0
	glow_mats.append(m)
	return m


func _temp_mat(base: Color, metal := 0.6) -> StandardMaterial3D:
	var m := _mat(base, metal, 0.35)
	m.emission_enabled = true
	temp_mats.append(m)
	return m


func _box(s: Vector3, p: Vector3, m: Material, parent: Node3D = null) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = s.max(Vector3.ONE * 0.0005)
	mi.mesh = bm
	mi.material_override = m
	mi.position = p
	(parent if parent else vib).add_child(mi)
	return mi


## Cylinder of radius r and length h whose axis is `axis` (UP, RIGHT or BACK).
func _cyl(r: float, h: float, p: Vector3, m: Material, axis := Vector3.UP, parent: Node3D = null, segs := 20) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = r
	cm.bottom_radius = r
	cm.height = maxf(h, 0.0005)
	cm.radial_segments = segs
	cm.rings = 1
	mi.mesh = cm
	mi.material_override = m
	mi.position = p
	if axis == Vector3.RIGHT:
		mi.rotation.z = PI / 2
	elif axis == Vector3.BACK:
		mi.rotation.x = PI / 2
	(parent if parent else vib).add_child(mi)
	return mi


func _sphere(r: float, p: Vector3, m: Material, parent: Node3D = null) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = r
	sm.height = r * 2
	sm.radial_segments = 16
	sm.rings = 8
	mi.mesh = sm
	mi.material_override = m
	mi.position = p
	(parent if parent else vib).add_child(mi)
	return mi


func _torus(r: float, thick: float, p: Vector3, m: Material, axis := Vector3.UP, parent: Node3D = null) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = maxf(r - thick, 0.0001)
	tm.outer_radius = r
	tm.rings = 24
	tm.ring_segments = 8
	mi.mesh = tm
	mi.material_override = m
	mi.position = p
	if axis == Vector3.BACK:
		mi.rotation.x = PI / 2
	elif axis == Vector3.RIGHT:
		mi.rotation.z = PI / 2
	(parent if parent else vib).add_child(mi)
	return mi


func _pivot(p := Vector3.ZERO, parent: Node3D = null) -> Node3D:
	var n := Node3D.new()
	n.position = p
	(parent if parent else vib).add_child(n)
	return n


## Index (0 x, 1 y, 2 z) and unit vector of the longest side.
func _long_axis() -> Vector3:
	if size.x >= size.y and size.x >= size.z:
		return Vector3.RIGHT
	if size.z >= size.y:
		return Vector3.BACK
	return Vector3.UP


func _across(axis: Vector3) -> float:
	# smallest side perpendicular to the axis
	if axis == Vector3.RIGHT:
		return minf(size.y, size.z)
	if axis == Vector3.BACK:
		return minf(size.x, size.y)
	return minf(size.x, size.z)


func _len(axis: Vector3) -> float:
	return absf(size.dot(axis))


## A fill block that grows from the bottom of the part (scale.y = level).
func _make_fill(s: Vector3, p_bottom: Vector3, m: Material, parent: Node3D = null) -> void:
	fill = _pivot(p_bottom, parent)
	_box(s, Vector3(0, s.y / 2, 0), m, fill)


func _halo() -> void:
	halo_mat = _mat(Color(0, 0, 0, 0))
	halo_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	halo_mat.cull_mode = BaseMaterial3D.CULL_FRONT
	halo_mat.no_depth_test = false
	var m := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size * 1.18 + Vector3.ONE * size.length() * 0.04
	m.mesh = bm
	m.material_override = halo_mat
	add_child(m)


# ---------------------------------------------------------------- models

func _filter() -> void:
	var frame := _mat(DARK, 0.0, 0.6)
	var t := minf(size.x, minf(size.y, size.z))
	_box(Vector3(size.x, size.y, size.z) * Vector3(1, 1, 1), Vector3.ZERO, _mat(Color(0.9, 0.92, 0.95, 0.25)))
	# mesh grid
	var n := 12
	for i in n + 1:
		var x := -size.x / 2 + size.x * i / n
		_box(Vector3(t * 0.08, size.y, size.z * 1.02), Vector3(x, 0, 0), frame)
	for j in 5:
		var y := -size.y / 2 + size.y * j / 4.0
		_box(Vector3(size.x, t * 0.08, size.z * 1.02), Vector3(0, y, 0), frame)
	dirt_mat = _mat(Color(0.42, 0.33, 0.22, 0.0), 0.0, 1.0)
	_box(size * Vector3(0.98, 0.98, 1.04), Vector3.ZERO, dirt_mat)


func _coil() -> void:
	# Aluminium fins with copper hairpin tubes; tinted by refrigerant temperature, frost below 3 °C.
	var thin := _across(Vector3.RIGHT)
	var fin := _temp_mat(ALU, 0.7)
	var n := 28
	for i in n:
		var x := -size.x / 2 + size.x * (i + 0.5) / n
		_box(Vector3(size.x / n * 0.25, size.y, size.z), Vector3(x, 0, 0), fin)
	var cu := _mat(COPPER, 0.9, 0.3)
	for row in 3:
		for col in 2:
			var y := -size.y / 2 + size.y * (row + 0.5) / 3.0
			var z := -size.z / 4 + size.z / 2 * col
			_cyl(thin * 0.09, size.x * 1.04, Vector3(0, y, z), cu, Vector3.RIGHT)
	for row in 3:
		_torus(size.y / 6.0, thin * 0.05, Vector3(size.x * 0.52, -size.y / 2 + size.y * (row + 0.5) / 3.0, 0), cu, Vector3.RIGHT)
	frost_mat = _mat(Color(0.95, 0.97, 1.0, 0.0), 0.0, 0.9)
	_box(size * 1.03, Vector3.ZERO, frost_mat)


func _fan_cross() -> void:
	var ax := Vector3.RIGHT
	var L := _len(ax)
	var r := _across(ax) * 0.45
	spinner = _pivot()
	spin_axis = Vector3.RIGHT
	var blade := _mat(WHITE, 0.0, 0.4)
	for i in 24:
		var a := TAU * i / 24.0
		var b := _box(Vector3(L * 0.96, r * 0.32, r * 0.05), Vector3(0, cos(a) * r * 0.82, sin(a) * r * 0.82), blade, spinner)
		b.rotation.x = a + 0.5
	for k in 5:
		_cyl(r, L * 0.012, Vector3(-L / 2 + L * k / 4.0, 0, 0), _mat(Color(0.8, 0.82, 0.85)), Vector3.RIGHT, spinner)
	_cyl(r * 0.1, L, Vector3.ZERO, _mat(STEEL, 0.8, 0.3), Vector3.RIGHT, spinner)


func _fan_axial() -> void:
	# axis = thinnest side (fan faces outwards)
	var ax := Vector3.BACK if size.z <= size.x and size.z <= size.y else (Vector3.UP if size.y <= size.x else Vector3.RIGHT)
	var r := minf(_across_for(ax), 10.0) * 0.48
	spinner = _pivot()
	spin_axis = ax
	_torus(r * 1.04, r * 0.06, Vector3.ZERO, _mat(DARK), ax)
	var hub := _cyl(r * 0.18, _len(ax) * 0.8, Vector3.ZERO, _mat(DARK, 0.2, 0.4), ax, spinner)
	hub.name = "hub"
	var bl := _mat(Color(0.35, 0.38, 0.42), 0.3, 0.4)
	for i in 5:
		var holder := _pivot(Vector3.ZERO, spinner)
		holder.rotate(ax, TAU * i / 5.0)
		var blade := _box(Vector3(r * 0.36, r * 0.75, maxf(_len(ax) * 0.12, r * 0.02)) if ax == Vector3.BACK else Vector3(r * 0.36, maxf(_len(ax) * 0.12, r * 0.02), r * 0.75), Vector3.ZERO, bl, holder)
		if ax == Vector3.BACK:
			blade.position = Vector3(0, r * 0.55, 0)
			blade.rotation.y = 0.45
		elif ax == Vector3.UP:
			blade.position = Vector3(0, 0, r * 0.55)
			blade.rotation.z = 0.45
		else:
			blade.position = Vector3(0, r * 0.55, 0)
			blade.rotation.x = 0.45


func _across_for(ax: Vector3) -> float:
	if ax == Vector3.BACK:
		return minf(size.x, size.y)
	if ax == Vector3.UP:
		return minf(size.x, size.z)
	return minf(size.y, size.z)


func _motor() -> void:
	var ax := _long_axis()
	var r := _across(ax) * 0.45
	var L := _len(ax)
	_cyl(r, L * 0.75, Vector3.ZERO, _mat(Color(0.25, 0.27, 0.3), 0.6, 0.35), ax)
	for k in 6:
		var a := TAU * k / 6.0
		var off := Vector3(0, cos(a), sin(a)) if ax == Vector3.RIGHT else (Vector3(cos(a), 0, sin(a)) if ax == Vector3.UP else Vector3(cos(a), sin(a), 0))
		_box((Vector3.ONE - ax.abs()) * r * 0.12 + ax.abs() * L * 0.7, off * r, _mat(Color(0.3, 0.32, 0.35), 0.6, 0.35))
	spinner = _pivot()
	spin_axis = ax
	_cyl(r * 0.12, L, Vector3.ZERO, _mat(STEEL, 0.9, 0.2), ax, spinner)
	_box((Vector3.ONE - ax.abs()) * r * 0.5 + ax.abs() * L * 0.06, ax * L * 0.45, _mat(COPPER, 0.8, 0.3), spinner)
	var winding := _glow_mat(Color(1.0, 0.55, 0.2))
	_cyl(r * 0.6, L * 0.1, -ax * L * 0.4, winding, ax)


func _sensor() -> void:
	# thermistor bead on a lead, the bead coloured by the measured temperature
	var s := minf(size.x, minf(size.y, size.z))
	_cyl(s * 0.08, size.y, Vector3.ZERO, _mat(DARK), Vector3.UP)
	_sphere(s * 0.38, Vector3(0, -size.y * 0.3, 0), _temp_mat(Color(0.6, 0.6, 0.6), 0.1))
	_cyl(s * 0.3, size.y * 0.2, Vector3(0, size.y * 0.35, 0), _mat(WHITE), Vector3.UP)


func _louver() -> void:
	var m := _mat(WHITE, 0.0, 0.4)
	for i in 2:
		var h := _pivot(Vector3(0, 0, -size.z / 4 + i * size.z / 2))
		_box(Vector3(size.x, size.y * 0.15, size.z * 0.45), Vector3.ZERO, m, h)
		hinges.append(h)
	_cyl(minf(size.y, size.z) * 0.15, size.x * 0.06, Vector3(size.x * 0.5, 0, 0), _mat(DARK), Vector3.RIGHT)


func _tray() -> void:
	var w := _mat(Color(0.75, 0.77, 0.8), 0.1, 0.5)
	var t := size.y * 0.15
	_box(Vector3(size.x, t, size.z), Vector3(0, -size.y / 2 + t / 2, 0), w)
	_box(Vector3(size.x, size.y, t), Vector3(0, 0, size.z / 2), w)
	_box(Vector3(size.x, size.y, t), Vector3(0, 0, -size.z / 2), w)
	var water := _mat(WATER, 0.0, 0.1)
	_make_fill(Vector3(size.x * 0.96, size.y * 0.6, size.z * 0.9), Vector3(0, -size.y / 2 + t, 0), water)
	target.level = 0.35
	droplets = _pivot(Vector3(size.x * 0.45, -size.y / 2, 0))
	for i in 3:
		var d := _sphere(t * 0.6, Vector3.ZERO, water, droplets)
		d.set_meta("ph", i / 3.0)
	droplets.visible = false
	blink_mat = null


func _pcb() -> void:
	var thin := minf(size.x, minf(size.y, size.z))
	var ax := Vector3.RIGHT if size.x == thin else (Vector3.UP if size.y == thin else Vector3.BACK)
	var board := _box(size, Vector3.ZERO, _mat(PCB, 0.1, 0.6))
	board.name = "board"
	var face := ax * thin * 0.5
	var chip := _mat(DARK, 0.2, 0.4)
	var span := size - ax.abs() * size
	for i in 5:
		var off := Vector3((i % 3 - 1) * 0.28, (i / 3 - 0.5) * 0.4, 0)
		var p: Vector3
		if ax == Vector3.RIGHT:
			p = face + Vector3(0, off.x * span.y, off.y * span.z)
		elif ax == Vector3.UP:
			p = face + Vector3(off.x * span.x, 0, off.y * span.z)
		else:
			p = face + Vector3(off.x * span.x, off.y * span.y, 0)
		_box((Vector3.ONE - ax.abs()) * maxf(span.x, maxf(span.y, span.z)) * 0.14 + ax.abs() * thin * 0.4, p, chip)
	blink_mat = _mat(Color(0.3, 1.0, 0.4))
	blink_mat.emission_enabled = true
	blink_mat.emission = Color(0.3, 1.0, 0.4)
	_sphere(thin * 0.35, face + (Vector3.ONE - ax.abs()) * span * 0.4, blink_mat)
	target.active = 1.0


func _radio() -> void:
	_box(size * Vector3(1, 0.6, 1), Vector3.ZERO, _mat(PCB, 0.1, 0.6))
	_box(size * Vector3(0.5, 0.25, 0.5), Vector3(0, size.y * 0.3, 0), _mat(ALU, 0.8, 0.3))
	var ant := _cyl(minf(size.x, size.z) * 0.05, size.y * 1.2, Vector3(size.x * 0.4, size.y * 0.6, 0), _mat(DARK))
	ant.name = "antenna"
	for i in 3:
		var rm := _mat(Color(0.55, 0.75, 1.0, 0.0))
		rm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		var r := _torus(size.length() * 0.6, size.length() * 0.03, Vector3(size.x * 0.4, size.y * 1.2, 0), rm, Vector3.UP)
		rings.append(r)


func _compressor() -> void:
	# rotary compressor: steel shell with domed ends, terminal box, suction/discharge stubs
	var r := minf(size.x, size.z) * 0.45
	var shell := _temp_mat(Color(0.25, 0.27, 0.3), 0.5)
	_cyl(r, size.y * 0.7, Vector3.ZERO, shell, Vector3.UP)
	_sphere(r, Vector3(0, size.y * 0.35, 0), shell).scale = Vector3(1, 0.4, 1)
	_sphere(r, Vector3(0, -size.y * 0.35, 0), shell).scale = Vector3(1, 0.4, 1)
	_box(Vector3(r * 0.6, r * 0.5, r * 0.4), Vector3(0, size.y * 0.1, r * 1.05), _mat(DARK))
	var cu := _mat(COPPER, 0.9, 0.3)
	_cyl(r * 0.12, size.y * 0.3, Vector3(0, size.y * 0.55, 0), cu)
	_cyl(r * 0.14, r * 1.2, Vector3(-r * 1.0, -size.y * 0.15, 0), cu, Vector3.RIGHT)
	_cyl(r * 1.15, size.y * 0.04, Vector3(0, -size.y * 0.48, 0), _mat(DARK))
	# rotor glimpse through a cut window: spins with compressor speed
	spinner = _pivot(Vector3(0, -size.y * 0.05, 0))
	spin_axis = Vector3.UP
	_box(Vector3(r * 1.6, size.y * 0.06, r * 0.25), Vector3.ZERO, _mat(COPPER, 0.8, 0.3), spinner)


func _gauge() -> void:
	var r := minf(size.x, size.z) * 0.6
	_cyl(r * 0.5, size.y * 0.8, Vector3(0, -size.y * 0.1, 0), _mat(Color(0.7, 0.55, 0.3), 0.8, 0.3))
	var dial := _pivot(Vector3(0, size.y * 0.45, 0))
	_cyl(r, r * 0.25, Vector3.ZERO, _mat(WHITE), Vector3.BACK, dial)
	_torus(r, r * 0.08, Vector3.ZERO, _mat(DARK), Vector3.BACK, dial)
	needle = _pivot(Vector3(0, 0, r * 0.15), dial)
	_box(Vector3(r * 0.08, r * 0.85, r * 0.04), Vector3(0, r * 0.4, 0), _mat(Color(0.85, 0.15, 0.1)), needle)


func _tank() -> void:
	var r := minf(size.x, size.z) * 0.45
	var m := _temp_mat(Color(0.3, 0.32, 0.36), 0.5)
	_cyl(r, size.y * 0.75, Vector3.ZERO, m)
	_sphere(r, Vector3(0, size.y * 0.37, 0), m).scale = Vector3(1, 0.35, 1)
	_sphere(r, Vector3(0, -size.y * 0.37, 0), m).scale = Vector3(1, 0.35, 1)
	_cyl(r * 0.15, size.y * 0.3, Vector3(0, size.y * 0.55, 0), _mat(COPPER, 0.9, 0.3))


func _valve() -> void:
	var r := minf(size.x, size.z) * 0.4
	var brass := _mat(Color(0.75, 0.6, 0.3), 0.85, 0.3)
	_cyl(r, size.y * 0.45, Vector3(0, -size.y * 0.2, 0), brass)
	_cyl(r * 0.35, size.x * 1.4, Vector3(0, -size.y * 0.25, 0), _mat(COPPER, 0.9, 0.3), Vector3.RIGHT)
	_cyl(r * 0.8, size.y * 0.35, Vector3(0, size.y * 0.2, 0), _mat(DARK, 0.3, 0.5))
	slider = _pivot()
	slide_a = Vector3(0, size.y * 0.25, 0)
	slide_b = Vector3(0, size.y * 0.48, 0)
	_cyl(r * 0.25, size.y * 0.25, Vector3.ZERO, _mat(STEEL, 0.9, 0.2), Vector3.UP, slider)


func _heatsink() -> void:
	var base := _box(Vector3(size.x, size.y * 0.25, size.z), Vector3(0, -size.y * 0.375, 0), _mat(PCB, 0.1, 0.6))
	base.name = "board"
	var al := _glow_mat(ALU)
	glow_color = Color(1.0, 0.5, 0.2)
	al.emission = glow_color
	for i in 7:
		_box(Vector3(size.x * 0.04, size.y * 0.7, size.z * 0.8), Vector3(-size.x * 0.42 + size.x * 0.84 * i / 6.0, size.y * 0.1, 0), al)


func _led_disc() -> void:
	var r := minf(size.x, size.z) * 0.5
	_cyl(r, size.y * 0.4, Vector3.ZERO, _mat(ALU, 0.6, 0.3))
	var led := _glow_mat(Color(1.0, 0.95, 0.8))
	for ring in [0.3, 0.6, 0.85]:
		var n := int(6 + ring * 14)
		for i in n:
			var a := TAU * i / n
			_box(Vector3(r * 0.08, size.y * 0.3, r * 0.08), Vector3(cos(a) * r * ring, -size.y * 0.25, sin(a) * r * ring), led)


func _diffuser() -> void:
	var m := _glow_mat(Color(1.0, 0.97, 0.9, 0.45))
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	var s := _sphere(minf(size.x, size.z) * 0.5, Vector3.ZERO, m)
	s.scale = Vector3(1, size.y / minf(size.x, size.z), 1)


func _panel() -> void:
	_box(size, Vector3.ZERO, _mat(DARK, 0.2, 0.3))
	var screen := _glow_mat(Color(0.35, 0.55, 0.9))
	screen.albedo_color = Color(0.04, 0.05, 0.07)  # black when off; the picture is emission only
	_box(size * Vector3(0.94, 0.9, 0.2), Vector3(0, 0, size.z * 0.45), screen)


func _cone() -> void:
	var r := minf(size.x, size.y) * 0.5
	var basket := _mat(DARK, 0.4, 0.4)
	_torus(r, r * 0.1, Vector3(0, 0, size.z * 0.3), _mat(Color(0.2, 0.2, 0.22)), Vector3.BACK)
	slider = _pivot()
	slide_a = Vector3.ZERO
	slide_b = Vector3(0, 0, size.z * 0.15)
	var cone := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = r * 0.9
	cm.bottom_radius = r * 0.2
	cm.height = size.z * 0.5
	cone.mesh = cm
	cone.material_override = _mat(Color(0.15, 0.15, 0.17), 0.0, 0.8)
	cone.rotation.x = PI / 2
	slider.add_child(cone)
	_cyl(r * 0.35, size.z * 0.3, Vector3(0, 0, -size.z * 0.35), basket, Vector3.BACK)


func _dome() -> void:
	var r := minf(size.x, size.z) * 0.5
	_cyl(r, size.y * 0.3, Vector3(0, -size.y * 0.3, 0), _mat(WHITE))
	var d := _sphere(r * 0.8, Vector3(0, 0, 0), _glow_mat(Color(0.9, 0.95, 1.0, 0.8)))
	d.scale = Vector3(1, 0.7, 1)
	for i in 2:
		var rm := _mat(Color(1.0, 0.6, 0.3, 0.0))
		rm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		rings.append(_torus(r * 1.6, r * 0.06, Vector3(0, size.y * 0.2, 0), rm, Vector3.UP))


func _roller() -> void:
	var ax := _long_axis()
	var r := _across(ax) * 0.45
	var L := _len(ax)
	spinner = _pivot()
	spin_axis = ax
	_cyl(r, L * 0.9, Vector3.ZERO, _mat(Color(0.75, 0.77, 0.8), 0.6, 0.3), ax, spinner)
	for i in 8:
		var a := TAU * i / 8.0
		var off := Vector3(0, cos(a), sin(a)) if ax == Vector3.RIGHT else (Vector3(cos(a), 0, sin(a)) if ax == Vector3.UP else Vector3(cos(a), sin(a), 0))
		_box(ax.abs() * L * 0.88 + (Vector3.ONE - ax.abs()) * r * 0.15, off * r, _mat(Color(0.2, 0.45, 0.85)), spinner)
	_cyl(r * 1.1, L * 0.05, ax * L * 0.47, _mat(DARK), ax)
	_cyl(r * 1.1, L * 0.05, -ax * L * 0.47, _mat(DARK), ax)


func _battery() -> void:
	var ax := _long_axis()
	var r := _across(ax) * 0.45
	var L := _len(ax)
	_cyl(r, L * 0.9, Vector3.ZERO, _mat(Color(0.85, 0.87, 0.9, 0.35), 0.2, 0.2), Vector3.UP)
	_cyl(r * 0.35, L * 0.1, Vector3(0, L * 0.48, 0), _mat(STEEL, 0.8, 0.3))
	var gm := _mat(Color(0.25, 0.75, 0.35))
	gm.emission_enabled = true
	gm.emission = Color(0.25, 0.75, 0.35) * 0.4
	_make_fill(Vector3(r * 1.3, L * 0.86, r * 1.3), Vector3(0, -L * 0.43, 0), gm)
	fill.set_meta("mat", gm)


func _serpentine() -> void:
	var cu := _temp_mat(COPPER, 0.9)
	var thin := minf(size.x, minf(size.y, size.z))
	var rows := 6
	for i in rows:
		var y := -size.y / 2 + size.y * (i + 0.5) / rows
		_cyl(thin * 0.2, size.x * 0.9, Vector3(0, y, 0), cu, Vector3.RIGHT)
	for i in rows - 1:
		var y := -size.y / 2 + size.y * (i + 1.0) / rows
		var side := 0.45 if i % 2 == 0 else -0.45
		_torus(size.y / rows * 0.5, thin * 0.2, Vector3(size.x * side, y, 0), cu, Vector3.BACK)
	frost_mat = _mat(Color(0.95, 0.97, 1.0, 0.0), 0.0, 0.9)
	_box(size * Vector3(0.95, 1.0, 1.4), Vector3.ZERO, frost_mat)


func _button() -> void:
	_box(size * Vector3(1, 1, 0.5), Vector3(0, 0, -size.z * 0.25), _mat(DARK))
	slider = _pivot()
	slide_a = Vector3(0, 0, size.z * 0.2)
	slide_b = Vector3(0, 0, size.z * 0.45)
	_cyl(minf(size.x, size.y) * 0.35, size.z * 0.3, Vector3.ZERO, _glow_mat(Color(0.5, 0.75, 1.0)), Vector3.BACK, slider)
	for i in 2:
		var rm := _mat(Color(0.5, 0.75, 1.0, 0.0))
		rm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		rings.append(_torus(minf(size.x, size.y) * 0.6, minf(size.x, size.y) * 0.04, Vector3(0, 0, size.z * 0.5), rm, Vector3.BACK))


func _heater() -> void:
	# coiled resistance element, glowing with power / temperature
	var m := _glow_mat(Color(0.35, 0.3, 0.28))
	m.emission = Color(1.0, 0.35, 0.1)
	var ax := _long_axis()
	var L := _len(ax)
	var r := _across(ax) * 0.4
	var turns := 10
	for i in turns:
		var p := ax * (-L * 0.45 + L * 0.9 * i / float(turns - 1))
		_torus(r, r * 0.25, p, m, ax)
	_cyl(r * 0.3, L, Vector3.ZERO, _mat(STEEL, 0.8, 0.3), ax)


func _bin() -> void:
	_box(size, Vector3.ZERO, _mat(Color(0.85, 0.87, 0.9, 0.3), 0.0, 0.2))
	_make_fill(size * Vector3(0.94, 0.94, 0.94), Vector3(0, -size.y * 0.47, 0), _mat(Color(0.45, 0.4, 0.35)))


func _lidar() -> void:
	var r := minf(size.x, size.z) * 0.45
	_cyl(r, size.y * 0.4, Vector3(0, -size.y * 0.3, 0), _mat(DARK))
	spinner = _pivot(Vector3(0, size.y * 0.1, 0))
	spin_axis = Vector3.UP
	_cyl(r * 0.85, size.y * 0.45, Vector3.ZERO, _mat(Color(0.25, 0.27, 0.3), 0.4, 0.3), Vector3.UP, spinner)
	var laser := _mat(Color(1, 0.2, 0.2))
	laser.emission_enabled = true
	laser.emission = Color(1, 0.2, 0.2)
	laser.emission_energy_multiplier = 3.0
	_box(Vector3(r * 0.3, size.y * 0.15, r * 0.2), Vector3(0, 0, r * 0.85), laser, spinner)


func _lens() -> void:
	var r := minf(size.x, size.y) * 0.42
	_box(size * Vector3(1, 1, 0.5), Vector3(0, 0, -size.z * 0.25), _mat(PCB, 0.1, 0.6))
	_cyl(r, size.z * 0.6, Vector3(0, 0, size.z * 0.15), _mat(DARK, 0.3, 0.3), Vector3.BACK)
	var glass := _mat(Color(0.2, 0.35, 0.6, 0.85), 0.5, 0.05)
	_cyl(r * 0.75, size.z * 0.1, Vector3(0, 0, size.z * 0.45), glass, Vector3.BACK)
	blink_mat = _mat(Color(1, 0.2, 0.2))
	blink_mat.emission_enabled = true
	blink_mat.emission = Color(1, 0.2, 0.2)
	_sphere(r * 0.12, Vector3(r * 1.1, r * 0.9, size.z * 0.3), blink_mat)


func _led_ring() -> void:
	var r := minf(size.x, size.y) * 0.45
	var ir := _glow_mat(Color(0.6, 0.1, 0.1))
	ir.emission = Color(0.9, 0.15, 0.15)
	for i in 10:
		var a := TAU * i / 10.0
		_sphere(r * 0.12, Vector3(cos(a) * r, sin(a) * r * 0.5, 0), ir)


func _bolt() -> void:
	var ax := _long_axis()
	_box(size * 0.7, -ax * _len(ax) * 0.1, _mat(STEEL, 0.6, 0.4))
	slider = _pivot()
	slide_a = -ax * _len(ax) * 0.15
	slide_b = ax * _len(ax) * 0.35
	_box(ax.abs() * _len(ax) * 0.6 + (Vector3.ONE - ax.abs()) * _across(ax) * 0.4, Vector3.ZERO, _mat(Color(0.85, 0.75, 0.4), 0.9, 0.25), slider)


func _keypad() -> void:
	_box(size, Vector3.ZERO, _mat(DARK, 0.1, 0.4))
	var key := _glow_mat(Color(0.75, 0.85, 1.0))
	target.glow = 0.3
	for r in 4:
		for c in 3:
			_box(Vector3(size.x * 0.22, size.y * 0.16, size.z * 0.3), Vector3(-size.x * 0.28 + c * size.x * 0.28, size.y * 0.33 - r * size.y * 0.22, size.z * 0.5), key)


func _pump() -> void:
	var r := minf(size.x, size.z) * 0.45
	var vol := _mat(Color(0.2, 0.22, 0.25, 0.55), 0.1, 0.3)
	_cyl(r, size.y * 0.8, Vector3.ZERO, vol)
	spinner = _pivot()
	spin_axis = Vector3.UP
	var imp := _mat(Color(0.85, 0.87, 0.9), 0.3, 0.3)
	for i in 6:
		var b := _box(Vector3(r * 0.85, size.y * 0.6, r * 0.08), Vector3.ZERO, imp, spinner)
		b.rotation.y = TAU * i / 6.0
		b.position = Vector3(cos(-b.rotation.y), 0, sin(-b.rotation.y)) * r * 0.35
	_cyl(r * 0.3, r * 1.4, Vector3(r * 1.0, 0, 0), _mat(Color(0.3, 0.32, 0.36)), Vector3.RIGHT)


func _level_tube() -> void:
	var r := minf(size.x, size.z) * 0.4
	_cyl(r, size.y, Vector3.ZERO, _mat(Color(0.85, 0.9, 0.95, 0.3), 0.0, 0.1))
	_make_fill(Vector3(r * 1.3, size.y * 0.96, r * 1.3), Vector3(0, -size.y * 0.48, 0), _mat(WATER, 0.0, 0.1))
	_cyl(r * 1.1, size.y * 0.05, Vector3(0, size.y * 0.5, 0), _mat(DARK))


func _drum() -> void:
	# front-loading drum, axis towards the front (z); perforated stainless, water level inside
	var r := minf(size.x, size.y) * 0.48
	var L := size.z
	var tub := _mat(Color(0.75, 0.78, 0.82, 0.25), 0.4, 0.2)
	_cyl(r * 1.04, L, Vector3.ZERO, tub, Vector3.BACK)
	spinner = _pivot()
	spin_axis = Vector3.BACK
	var ss := _mat(Color(0.8, 0.82, 0.86), 0.9, 0.25)
	for i in 12:
		var a := TAU * i / 12.0
		var slat := _box(Vector3(r * 0.5, r * 0.03, L * 0.9), Vector3(cos(a), sin(a), 0) * r * 0.95, ss, spinner)
		slat.rotation.z = a + PI / 2
	for i in 3:
		var a := TAU * i / 3.0
		var lift := _box(Vector3(r * 0.08, r * 0.25, L * 0.85), Vector3(cos(a), sin(a), 0) * r * 0.8, _mat(WHITE), spinner)
		lift.rotation.z = a + PI / 2
	_torus(r * 1.05, r * 0.08, Vector3(0, 0, L * 0.5), _mat(Color(0.3, 0.32, 0.35)), Vector3.BACK)
	_make_fill(Vector3(r * 1.9, r * 1.9, L * 0.9), Vector3(0, -r * 0.95, 0), _mat(WATER, 0.0, 0.1))


func _probe() -> void:
	_box(size * Vector3(1, 0.4, 1), Vector3(0, size.y * 0.2, 0), _mat(WHITE))
	var gold := _mat(Color(0.9, 0.75, 0.35), 0.9, 0.2)
	for x in [-0.25, 0.25]:
		_cyl(minf(size.x, size.z) * 0.06, size.y * 0.6, Vector3(size.x * x, -size.y * 0.2, 0), gold)
	droplets = _pivot(Vector3(0, size.y * 0.5, 0))
	for i in 4:
		var d := _sphere(minf(size.x, size.z) * 0.07, Vector3(size.x * (i - 1.5) * 0.2, 0, 0), _mat(WATER, 0.0, 0.05), droplets)
		d.set_meta("ph", i * 0.25)
	droplets.visible = false
	var puddle := _mat(Color(0.25, 0.65, 0.9, 0.0), 0.0, 0.05)
	dirt_mat = puddle  # reuse: puddle alpha follows "dirt"; wet drives both
	_cyl(size.x * 0.9, size.y * 0.04, Vector3(0, -size.y * 0.52, 0), puddle)


func _relay() -> void:
	_box(size, Vector3.ZERO, _mat(Color(0.2, 0.35, 0.75, 0.6), 0.0, 0.3))
	_box(size * Vector3(0.4, 0.5, 0.4), Vector3(-size.x * 0.2, -size.y * 0.1, 0), _mat(COPPER, 0.8, 0.3))
	slider = _pivot()
	slide_a = Vector3(size.x * 0.25, size.y * 0.25, 0)
	slide_b = Vector3(size.x * 0.12, size.y * 0.1, 0)
	_box(size * Vector3(0.35, 0.06, 0.3), Vector3.ZERO, _mat(STEEL, 0.9, 0.2), slider)


func _meter() -> void:
	_box(size, Vector3.ZERO, _mat(PCB, 0.1, 0.6))
	_box(size * Vector3(0.7, 0.45, 0.2), Vector3(0, size.y * 0.1, size.z * 0.45), _mat(Color(0.05, 0.1, 0.08)))
	text_label = Label3D.new()
	text_label.text = "-- W"
	text_label.modulate = Color(0.4, 1.0, 0.5)
	text_label.font_size = 40
	text_label.pixel_size = size.x * 0.0035
	text_label.position = Vector3(0, size.y * 0.1, size.z * 0.56)
	text_label.outline_size = 0
	vib.add_child(text_label)


func _hepa() -> void:
	var m := _mat(Color(0.95, 0.95, 0.92), 0.0, 0.9)
	var r := minf(size.x, size.z) * 0.5
	for i in 36:
		var a := TAU * i / 36.0
		var pleat := _box(Vector3(r * 0.25, size.y, r * 0.02), Vector3(cos(a), 0, sin(a)) * r * 0.8, m)
		pleat.rotation.y = -a
	_cyl(r, size.y * 0.06, Vector3(0, size.y * 0.5, 0), _mat(DARK))
	_cyl(r, size.y * 0.06, Vector3(0, -size.y * 0.5, 0), _mat(DARK))
	dirt_mat = _mat(Color(0.42, 0.36, 0.28, 0.0), 0.0, 1.0)
	_cyl(r * 1.02, size.y * 0.98, Vector3.ZERO, dirt_mat)


func _pm() -> void:
	_box(size, Vector3.ZERO, _mat(Color(0.2, 0.22, 0.25, 0.4), 0.0, 0.3))
	# particle cloud: density follows µg/m³ (level)
	fill = _pivot()
	for i in 24:
		var p := Vector3(randf_range(-0.4, 0.4) * size.x, randf_range(-0.4, 0.4) * size.y, randf_range(-0.4, 0.4) * size.z)
		_sphere(minf(size.x, minf(size.y, size.z)) * 0.05, p, _mat(Color(0.9, 0.7, 0.4)), fill)
	var laser := _mat(Color(1, 0.2, 0.2, 0.6))
	laser.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_box(Vector3(size.x * 0.9, size.y * 0.03, size.z * 0.03), Vector3.ZERO, laser)
