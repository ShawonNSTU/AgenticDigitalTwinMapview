class_name DeviceFx
extends Node3D
## What a device is doing, shown in the room: it follows the live state from the platform (Store.live, about
## once a second), so a command from the page, the guest's controls or the AI agent changes the room in 3D.
##   light    : a real light in the room (brightness and colour temperature) and a glowing lamp
##   ac       : air streams from the outlet (colour by mode, amount and speed by fan, aim by louver/swing), the
##              louver flap, a set-point tag, and the room floor tinted cool or warm while it works
##   tv       : the screen shows moving content and lights the room in front of it
##   blinds   : slats come down or go up; when open, a window glows and daylight falls on the floor
##   fan      : blades spin at the set speed, the head sweeps when oscillating, air moves in front
##   purifier : the ring glows by air quality and clean air rises
##   vacuum   : cleans a path around its room and goes back to its dock
##   lock     : green when unlocked, red when locked
## Offline devices go grey with a red "Offline" tag and stop doing anything.

const MODE_COL := {"cool": Color("7cc4ff"), "heat": Color("ff9b5a"), "dry": Color("b9e6ff"), "fan": Color("e5e7eb"), "auto": Color("a7f3d0")}

var type := ""
var dev: DeviceNode
var size := Vector3.ONE
var live: Dictionary = {}
var _t := randf() * 10.0
var _lamp: OmniLight3D
var _glow_mat: StandardMaterial3D
var _air: CPUParticles3D
var _flap: Node3D
var _tag: Label3D
var _screen_mat: StandardMaterial3D
var _slats: MeshInstance3D
var _window: MeshInstance3D
var _sun: MeshInstance3D
var _head: Node3D
var _blades: Node3D
var _spin := 0.0
var _home := Vector3.ZERO
var _goal := Vector3.ZERO
var _led_mat: StandardMaterial3D
var _offline: Label3D
var _room_key := ""
var _light_level := 0.0   # smoothed 0..1
var _blind_pos := -1.0    # smoothed 0..1 (1 = open)
var _win_h := 1.35        # window height, scaled like the walls


func setup(d: DeviceNode, t: String, s: Vector3) -> DeviceFx:
	dev = d
	type = t
	size = s
	_room_key = str(d.data.get("room", ""))
	match t:
		"light": _build_light()
		"ac": _build_ac()
		"tv": _build_tv()
		"blinds": _build_blinds()
		"fan": _build_fan()
		"purifier": _build_purifier()
		"vacuum": _home = Vector3.ZERO
		"lock", "plug": _build_led()
	_offline = Label3D.new()
	_offline.text = "Offline"
	_offline.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	_offline.fixed_size = true
	_offline.pixel_size = 0.0006
	_offline.font_size = 22
	_offline.modulate = Color("f85149")
	_offline.outline_size = 8
	_offline.position.y = size.y / 2 + 0.42
	_offline.visible = false
	add_child(_offline)
	return self


func apply(l: Dictionary) -> void:
	live = l
	var online: bool = l.get("online", true) != false
	_offline.visible = not online
	dev.body_mat.albedo_color = (Color("eef0f3") if type != "tv" else Color("22262c")).lerp(Color(0.45, 0.45, 0.47), 0.0 if online else 0.7)
	match type:
		"ac":
			var on: bool = online and bool(l.get("on", false))
			_air.emitting = on
			var mode: String = str(l.get("mode", "cool"))
			var col: Color = MODE_COL.get(mode, MODE_COL.cool)
			(_air.mesh.surface_get_material(0) as StandardMaterial3D).albedo_color = Color(col, 0.55)
			var fan: float = float(l.get("fan", 55.0)) / 100.0
			var amount: int = int(lerpf(20.0, 60.0, fan))
			if _air.amount != amount:
				_air.amount = amount  # changing the amount restarts the emitter: only when it really changes
			_air.initial_velocity_min = lerpf(0.4, 1.0, fan)
			_air.initial_velocity_max = lerpf(0.8, 1.8, fan)
			_tag.visible = on
			_tag.text = "%s° · %s" % [str(snappedf(float(l.get("set", 24.0)), 0.5)).trim_suffix(".0"), mode.capitalize()]
			_tag.modulate = col.lightened(0.2)
			_climate(on, col, l)
		"tv":
			var on: bool = online and bool(l.get("on", false))
			_screen_mat.emission_energy_multiplier = 1.6 if on else 0.0
			_screen_mat.albedo_color = Color("0b0d10") if not on else Color("1d2b44")
			_lamp.visible = on
		"purifier":
			var on: bool = online and bool(l.get("on", true))
			_air.emitting = on
			var amount: int = 8 + int(float(l.get("fan", 2)) * 6)
			if _air.amount != amount:
				_air.amount = amount
			var pm: float = float(l.get("pm", 10))
			_glow_mat.emission = Color("3b82f6") if pm < 15 else (Color("eab308") if pm < 35 else Color("ef4444"))
			_glow_mat.emission_energy_multiplier = 2.0 if on else 0.0
		"fan":
			var on: bool = online and bool(l.get("on", false))
			_air.emitting = on
		"lock":
			var locked: bool = bool(l.get("locked", true))
			_led_mat.emission = Color("ef4444") if locked else Color("22c55e")
			_led_mat.albedo_color = _led_mat.emission
		"plug":
			_led_mat.emission = Color("22c55e") if online and bool(l.get("on", true)) else Color("334155")


func _process(delta: float) -> void:
	_t += delta
	var online: bool = live.get("online", true) != false
	match type:
		"light":
			var target: float = (float(live.get("lv", 0.0)) / 100.0) if online else 0.0
			_light_level = lerpf(_light_level, target, 1.0 - exp(-4.0 * delta))
			var k: float = clampf((float(live.get("ct", 3000.0)) - 2700.0) / 3800.0, 0.0, 1.0)
			var col: Color = Color(1.0, 0.78, 0.52).lerp(Color(0.86, 0.92, 1.0), k)
			_lamp.light_color = col
			_lamp.light_energy = _light_level * (2.6 if Store.walk else 3.2)
			_lamp.visible = _light_level > 0.01
			_glow_mat.emission = col
			_glow_mat.emission_energy_multiplier = 0.2 + _light_level * 3.0
		"ac":
			if _flap:
				var swing: String = str(live.get("swing", "swing"))
				var on: bool = online and bool(live.get("on", false))
				var a: float = {"up": 15.0, "middle": 35.0, "down": 60.0}.get(swing, 35.0 + 20.0 * sin(_t * 0.9))
				_flap.rotation.x = deg_to_rad(a if on else 0.0)
				_air.direction = Vector3(0, -sin(deg_to_rad(a)), cos(deg_to_rad(a)))
		"tv":
			if _screen_mat.emission_energy_multiplier > 0.0:
				var src: String = str(live.get("input", "TV"))
				var base: float = {"TV": 0.58, "HDMI 1": 0.75, "HDMI 2": 0.9, "Apps": 0.08}.get(src, 0.58)
				var c: Color = Color.from_hsv(fposmod(base + 0.08 * sin(_t * 0.7), 1.0), 0.55, 0.9)
				_screen_mat.emission = c.lerp(Color.WHITE, 0.15 + 0.1 * sin(_t * 3.1))
				_lamp.light_color = c
				_lamp.light_energy = 0.8 + 0.25 * sin(_t * 2.3)
		"blinds":
			var target: float = float(live.get("pos", 100.0)) / 100.0
			_blind_pos = target if _blind_pos < 0.0 else lerpf(_blind_pos, target, 1.0 - exp(-3.0 * delta))
			var h: float = _win_h * (1.0 - _blind_pos) + 0.04
			_slats.scale.y = h
			_slats.position.y = -h / 2.0
			(_window.material_override as StandardMaterial3D).emission_energy_multiplier = 0.25 + 1.4 * _blind_pos
			_sun.visible = _blind_pos > 0.05
			(_sun.material_override as StandardMaterial3D).albedo_color.a = 0.22 * _blind_pos
		"fan":
			var on: bool = online and bool(live.get("on", false))
			var rps: float = [0.0, 6.0, 9.0, 13.0][clampi(int(live.get("speed", 2)), 0, 3)] if on else 0.0
			_spin = lerpf(_spin, rps, 1.0 - exp(-1.5 * delta))
			_blades.rotation.z += _spin * TAU * delta * 0.25
			if on and bool(live.get("osc", true)):
				_head.rotation.y = deg_to_rad(40.0) * sin(_t * 0.5)
		"vacuum":
			var cleaning: bool = online and str(live.get("state", "Docked")) == "Cleaning"
			var target: Vector3 = _goal if cleaning else _home
			if cleaning and (_goal == Vector3.ZERO or dev.body.position.distance_to(_goal) < 0.08):
				_goal = _pick_spot()
				target = _goal
			var p := dev.body.position
			var step := target - p
			step.y = 0.0
			if step.length() > 0.01:
				var v := step.normalized() * minf(step.length(), 0.35 * delta)
				dev.body.position += v
				dev.body.rotation.y = atan2(v.x, v.z)


## While the AC works, its room's floor takes on the mode's colour.
func _climate(on: bool, col: Color, _l: Dictionary) -> void:
	if FloorBuilder.current != null and is_instance_valid(FloorBuilder.current):
		FloorBuilder.current.climate_tint(_room_key, col, 0.18 if on else 0.0)


## A free spot in the vacuum's room (relative to the device), for its cleaning path.
func _pick_spot() -> Vector3:
	var r: Dictionary = Store.room(_room_key)
	if r.is_empty():
		return Vector3(randf_range(-1, 1), 0, randf_range(-1, 1))
	var poly := PlanGeo.room_poly(r)
	var bb := Rect2(poly[0], Vector2.ZERO)
	for v in poly:
		bb = bb.expand(v)
	for i in 30:
		var q := Vector2(randf_range(bb.position.x + 0.4, bb.end.x - 0.4), randf_range(bb.position.y + 0.4, bb.end.y - 0.4))
		if Geometry2D.is_point_in_polygon(q, poly):
			var local := dev.to_local(Vector3(q.x, dev.global_position.y, q.y))
			return Vector3(local.x, dev.body.position.y, local.z)
	return Vector3.ZERO


func _mat(c: Color, glow := false, alpha := 1.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(c, alpha)
	if alpha < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	if glow:
		m.emission_enabled = true
		m.emission = c
	return m


func _build_light() -> void:
	_lamp = OmniLight3D.new()
	_lamp.position.y = -size.y - 0.05
	var r: Dictionary = Store.room(_room_key)
	var reach := 4.0
	if not r.is_empty():
		var poly := PlanGeo.room_poly(r)
		var bb := Rect2(poly[0], Vector2.ZERO)
		for v in poly:
			bb = bb.expand(v)
		reach = clampf(maxf(bb.size.x, bb.size.y) * 0.55, 2.5, 7.0)
	_lamp.omni_range = reach
	_lamp.omni_attenuation = 1.2
	_lamp.shadow_enabled = false
	_lamp.light_energy = 0.0
	add_child(_lamp)
	_glow_mat = _mat(Color(1.0, 0.9, 0.75), true)
	var disc := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = size.x * 0.45
	cm.bottom_radius = size.x * 0.45
	cm.height = 0.012
	disc.mesh = cm
	disc.material_override = _glow_mat
	disc.position.y = -size.y * 0.62
	add_child(disc)


func _particles(col: Color, amount: int, life: float) -> CPUParticles3D:
	var p := CPUParticles3D.new()
	var qm := SphereMesh.new()
	qm.radius = 0.035
	qm.height = 0.07
	qm.radial_segments = 6
	qm.rings = 3
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.vertex_color_use_as_albedo = true
	m.albedo_color = Color(col, 0.55)
	qm.material = m
	p.mesh = qm
	p.amount = amount
	p.lifetime = life
	p.emitting = false
	p.local_coords = false
	p.gravity = Vector3.ZERO
	p.damping_min = 0.4
	p.damping_max = 0.8
	p.scale_amount_min = 0.6
	p.scale_amount_max = 1.4
	var fade := Gradient.new()
	fade.set_color(0, Color(1, 1, 1, 0.0))
	fade.add_point(0.2, Color(1, 1, 1, 0.9))
	fade.set_color(fade.get_point_count() - 1, Color(1, 1, 1, 0.0))
	p.color_ramp = fade
	add_child(p)
	return p


func _build_ac() -> void:
	_flap = Node3D.new()
	_flap.position = Vector3(0, -size.y * 0.45, size.z * 0.5)
	add_child(_flap)
	var flap := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = Vector3(size.x * 0.82, 0.012, 0.07)
	flap.mesh = bm
	flap.material_override = _mat(Color("dfe3e8"))
	flap.position.z = 0.035
	_flap.add_child(flap)
	_air = _particles(MODE_COL.cool, 40, 2.4)
	_air.position = Vector3(0, -size.y * 0.5, size.z * 0.55)
	_air.emission_shape = CPUParticles3D.EMISSION_SHAPE_BOX
	_air.emission_box_extents = Vector3(size.x * 0.4, 0.01, 0.02)
	_air.direction = Vector3(0, -0.6, 0.8)
	_air.spread = 12.0
	_tag = Label3D.new()
	_tag.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	_tag.fixed_size = true
	_tag.pixel_size = 0.0005
	_tag.font_size = 22
	_tag.outline_size = 8
	_tag.outline_modulate = Color(0.05, 0.07, 0.1, 0.85)
	_tag.position = Vector3(0, -size.y * 0.5 - 0.22, size.z * 0.6)
	_tag.visible = false
	add_child(_tag)


func _build_tv() -> void:
	_screen_mat = _mat(Color("0b0d10"), true)
	_screen_mat.emission_energy_multiplier = 0.0
	var scr := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = Vector3(size.x * 0.94, size.y * 0.88, 0.006)
	scr.mesh = bm
	scr.material_override = _screen_mat
	scr.position.z = size.z * 0.5 + 0.006
	add_child(scr)
	_lamp = OmniLight3D.new()
	_lamp.position = Vector3(0, 0, 0.6)
	_lamp.omni_range = 3.0
	_lamp.light_energy = 0.8
	_lamp.visible = false
	add_child(_lamp)


func _build_blinds() -> void:
	_win_h = 1.35 * minf(Store.wall_height / Placer.REAL_STOREY, 1.0)
	# the window behind the blind: a glowing pane, brighter as the blind opens
	_window = MeshInstance3D.new()
	var wm := BoxMesh.new()
	wm.size = Vector3(size.x * 0.95, _win_h, 0.01)
	_window.mesh = wm
	var glass := _mat(Color("cfe8ff"), true)
	glass.emission = Color("bfe0ff")
	_window.material_override = glass
	_window.position = Vector3(0, -_win_h / 2 - 0.03, -0.02)
	add_child(_window)
	_slats = MeshInstance3D.new()
	var sm := BoxMesh.new()
	sm.size = Vector3(size.x * 0.98, 1.0, 0.025)
	_slats.mesh = sm
	_slats.material_override = _mat(Color("e7e2d8"))
	add_child(_slats)
	# daylight on the floor in front of the window
	_sun = MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(size.x * 1.1, 1.6)
	_sun.mesh = pm
	var sun_mat := _mat(Color(1.0, 0.93, 0.7), false, 0.2)
	sun_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	sun_mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	_sun.material_override = sun_mat
	_sun.position = Vector3(0, -Placer.mount_y("blinds") + 0.02, 0.9)
	add_child(_sun)


func _build_fan() -> void:
	var grey := _mat(Color("e5e7eb"))
	var pole := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = 0.02
	cm.bottom_radius = 0.025
	cm.height = size.y * 0.8
	pole.mesh = cm
	pole.material_override = grey
	pole.position.y = -size.y * 0.08
	add_child(pole)
	_head = Node3D.new()
	_head.position.y = size.y * 0.36
	add_child(_head)
	var cage := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.19
	tm.outer_radius = 0.205
	cage.mesh = tm
	cage.material_override = grey
	cage.rotation.x = PI / 2
	cage.position.z = 0.06
	_head.add_child(cage)
	var motor := MeshInstance3D.new()
	var mm := CylinderMesh.new()
	mm.top_radius = 0.06
	mm.bottom_radius = 0.07
	mm.height = 0.12
	motor.mesh = mm
	motor.material_override = grey
	motor.rotation.x = PI / 2
	_head.add_child(motor)
	_blades = Node3D.new()
	_blades.position.z = 0.07
	_head.add_child(_blades)
	for i in 3:
		var b := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(0.07, 0.17, 0.008)
		b.mesh = bm
		b.material_override = _mat(Color("93c5fd"), false, 0.9)
		b.position = Vector3(0, 0.09, 0).rotated(Vector3.BACK, TAU * i / 3.0)
		b.rotation.z = TAU * i / 3.0
		_blades.add_child(b)
	_air = _particles(Color("e0f2fe"), 18, 1.6)
	_air.position = Vector3(0, size.y * 0.36, 0.12)
	_air.emission_shape = CPUParticles3D.EMISSION_SHAPE_SPHERE
	_air.emission_sphere_radius = 0.12
	_air.direction = Vector3(0, 0, 1)
	_air.spread = 18.0
	_air.initial_velocity_min = 0.8
	_air.initial_velocity_max = 1.5
	_air.local_coords = true


func _build_purifier() -> void:
	_glow_mat = _mat(Color("3b82f6"), true)
	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = size.x * 0.32
	tm.outer_radius = size.x * 0.4
	ring.mesh = tm
	ring.material_override = _glow_mat
	ring.position.y = size.y * 0.5 + 0.005
	add_child(ring)
	_air = _particles(Color("dbeafe"), 14, 2.2)
	_air.position.y = size.y * 0.5
	_air.emission_shape = CPUParticles3D.EMISSION_SHAPE_SPHERE
	_air.emission_sphere_radius = size.x * 0.3
	_air.direction = Vector3.UP
	_air.spread = 20.0
	_air.initial_velocity_min = 0.25
	_air.initial_velocity_max = 0.5


func _build_led() -> void:
	_led_mat = _mat(Color("ef4444"), true)
	_led_mat.emission_energy_multiplier = 2.5
	var led := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 0.012
	sm.height = 0.024
	led.mesh = sm
	led.material_override = _led_mat
	led.position = Vector3(0, size.y * 0.35, size.z * 0.5 + 0.01)
	add_child(led)
