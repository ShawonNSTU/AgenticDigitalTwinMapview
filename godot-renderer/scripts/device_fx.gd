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


var variant := ""
var _cur_col := Color(1.0, 0.85, 0.65)


func setup(d: DeviceNode, t: String, s: Vector3, v := "") -> DeviceFx:
	dev = d
	type = t
	size = s
	variant = v
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
			var hex := str(live.get("col", ""))
			if hex.begins_with("#") and hex.length() == 7:  # a colour bulb set to a colour
				col = Color.html(hex)
			_cur_col = _cur_col.lerp(col, 1.0 - exp(-6.0 * delta))
			col = _cur_col
			_lamp.light_color = col
			_lamp.light_energy = _light_level * (2.6 if Store.walk else 3.2) * {"lamp": 0.55, "desk": 0.35, "window": 0.45}.get(variant, 1.0)
			if variant == "window":
				var cur := _window_curtain()
				var open := cur._blind_pos if cur and cur._blind_pos >= 0.0 else 1.0
				_lamp.light_energy *= 0.25 + 0.75 * open  # the curtain holds most of it back
				_scene_mat.albedo_color = Color(0.06, 0.07, 0.1).lerp(Color.WHITE, _light_level)
				_cloud_mat.albedo_color = Color(1, 1, 1, _light_level)
				_cloud_mat.uv1_offset.x = (0.0 if _left else 0.5) + fmod(_t * 0.004, 1.0)
				if cur:
					cur._backlight[dev.data.get("id", "")] = _light_level
			if variant == "panel" and FloorBuilder.current:
				FloorBuilder.current.set_panels(_room_key, _light_level)
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
			if _window:
				(_window.material_override as StandardMaterial3D).emission_energy_multiplier = 0.25 + 1.4 * _blind_pos
				_sun.visible = _blind_pos > 0.05
				(_sun.material_override as StandardMaterial3D).albedo_color.a = 0.22 * _blind_pos
			elif variant == "curtain":  # lit windows behind glow through the white fabric
				var bl := 0.0
				for v in _backlight.values():
					bl = maxf(bl, float(v))
				(_slats.material_override as StandardMaterial3D).emission_energy_multiplier = bl * 0.16 * (1.0 - _blind_pos)
				(_slats.material_override as StandardMaterial3D).albedo_color = Color("f6f3ec").darkened(0.12 * (1.0 - bl))
			elif variant == "projector":  # a soft projected picture once it is mostly down
				(_slats.material_override as StandardMaterial3D).emission_energy_multiplier = clampf((0.6 - _blind_pos) * 1.2, 0.0, 0.5)
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
	if variant == "window":
		_build_window()
		return
	var disc := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = size.x * 0.45
	cm.bottom_radius = size.x * 0.45
	cm.height = 0.012
	disc.mesh = cm
	disc.material_override = _glow_mat
	disc.position.y = -size.y * 0.62
	add_child(disc)


# ---- the zone's window behind the curtain: one window, a left and a right pane, each lit from behind by its own
# smart light ("Left Window Light" / "Right Window Light"). Lit, a pane shows the outdoor view (sky with drifting clouds, sun,
# hills, trees, a lake); unlit it is dark glass. The curtain in front hides it as it comes down, and a lit window
# glows through the white fabric.

static var _scene_tex: ImageTexture
static var _cloud_tex: ImageTexture
var _scene_mat: StandardMaterial3D
var _cloud_mat: StandardMaterial3D
var _curtain: DeviceFx
var _left := true


static func _scene() -> ImageTexture:
	if _scene_tex:
		return _scene_tex
	var w := 512
	var h := 256
	var img := Image.create(w, h, false, Image.FORMAT_RGB8)
	var rng := RandomNumberGenerator.new()
	rng.seed = 401
	var sun := Vector2(w * 0.68, h * 0.26)
	# far, middle and near hill lines
	var ridge := func(x: float, base: float, amp: float, f1: float, f2: float, ph: float) -> float:
		return base + amp * (0.6 * sin(x * f1 + ph) + 0.4 * sin(x * f2 + ph * 1.7))
	for x in w:
		var fx := float(x)
		var r1: float = ridge.call(fx, h * 0.55, h * 0.06, 0.018, 0.047, 0.4)
		var r2: float = ridge.call(fx, h * 0.64, h * 0.05, 0.027, 0.071, 2.1)
		var lake_top := h * 0.74
		for y in h:
			var fy := float(y)
			var c: Color
			if fy < r1:  # sky: deep blue at the top to pale at the horizon, a warm glow round the sun
				var t := fy / r1
				c = Color(0.23, 0.5, 0.86).lerp(Color(0.72, 0.86, 0.97), t)
				var d := Vector2(fx, fy).distance_to(sun)
				c = c.lerp(Color(1.0, 0.96, 0.82), clampf(1.0 - d / 70.0, 0.0, 1.0) * 0.8)
				if d < 11.0:
					c = Color(1.0, 0.99, 0.92)
			elif fy < r2:  # far hills, hazy
				c = Color(0.46, 0.6, 0.62).lerp(Color(0.38, 0.55, 0.45), (fy - r1) / maxf(r2 - r1, 1.0))
			elif fy < lake_top:  # near hills, green
				c = Color(0.3, 0.55, 0.28).lerp(Color(0.22, 0.45, 0.2), (fy - r2) / maxf(lake_top - r2, 1.0))
			elif fy < h * 0.84:  # lake reflecting the sky
				var t2 := (fy - lake_top) / (h * 0.1)
				c = Color(0.45, 0.68, 0.86).lerp(Color(0.3, 0.52, 0.72), t2)
				if absf(fx - sun.x) < 14.0 - t2 * 6.0 and int(fy) % 3 != 0:
					c = c.lerp(Color(1, 0.97, 0.85), 0.55)
			else:  # grass in front
				c = Color(0.36, 0.6, 0.25).lerp(Color(0.27, 0.5, 0.2), (fy - h * 0.84) / (h * 0.16))
			img.set_pixel(x, y, c)
	# trees: dark rounded crowns on trunks along the near hills
	for i in 34:
		var tx := rng.randf_range(0, w)
		var base_y := h * rng.randf_range(0.69, 0.76)
		var rr := rng.randf_range(7.0, 15.0)
		var col := Color(0.13, rng.randf_range(0.3, 0.38), 0.14)
		for y in range(int(base_y - rr * 2.2), int(base_y)):
			for x in range(int(tx - rr), int(tx + rr)):
				if x < 0 or x >= w or y < 0 or y >= h:
					continue
				var dy := (y - (base_y - rr * 1.4)) / (rr * 1.1)
				var dx := (x - tx) / rr
				if dx * dx + dy * dy < 1.0:
					img.set_pixel(x, y, col.lerp(Color(0.25, 0.5, 0.22), clampf(-dx * 0.5 - dy * 0.3, 0.0, 0.6)))
				elif absf(x - tx) < 1.5 and y > base_y - rr * 0.6:
					img.set_pixel(x, y, Color(0.3, 0.22, 0.14))
	img.generate_mipmaps()
	_scene_tex = ImageTexture.create_from_image(img)
	return _scene_tex


static func _clouds() -> ImageTexture:
	if _cloud_tex:
		return _cloud_tex
	var n := FastNoiseLite.new()
	n.seed = 7
	n.frequency = 0.012
	n.fractal_octaves = 4
	var w := 512
	var h := 128
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	for y in h:
		for x in w:
			# seamless in x: blend the noise with its own wrap
			var a := n.get_noise_2d(x, y) * (1.0 - x / float(w)) + n.get_noise_2d(x - w, y) * (x / float(w))
			var cov := clampf((a + 0.05) * 2.4, 0.0, 1.0) * clampf(1.0 - y / float(h) * 0.9, 0.0, 1.0)
			img.set_pixel(x, y, Color(1, 1, 1, cov * 0.85))
	img.generate_mipmaps()
	_cloud_tex = ImageTexture.create_from_image(img)
	return _cloud_tex


func _build_window() -> void:
	_left = str(dev.data.get("name", "")).to_lower().begins_with("left")
	var k := minf(Store.wall_height / Placer.REAL_STOREY, 1.0)
	var ph := 1.05 * k
	var pw := size.x
	_lamp.position = Vector3(0, 0, 0.5)
	_lamp.omni_range = 2.4
	# outdoor view (each pane shows its half of one panorama)
	_scene_mat = StandardMaterial3D.new()
	_scene_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_scene_mat.albedo_texture = _scene()
	_scene_mat.uv1_scale = Vector3(0.5, 1, 1)
	_scene_mat.uv1_offset = Vector3(0.0 if _left else 0.5, 0, 0)
	_scene_mat.albedo_color = Color(0.06, 0.07, 0.1)
	var scene := MeshInstance3D.new()
	var qm := QuadMesh.new()
	qm.size = Vector2(pw, ph)
	scene.mesh = qm
	scene.material_override = _scene_mat
	scene.position.z = -0.012
	add_child(scene)
	# clouds drifting across the sky part
	_cloud_mat = StandardMaterial3D.new()
	_cloud_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_cloud_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_cloud_mat.albedo_texture = _clouds()
	_cloud_mat.uv1_scale = Vector3(0.5, 1, 1)
	_cloud_mat.albedo_color = Color(1, 1, 1, 0)
	var cl := MeshInstance3D.new()
	var cq := QuadMesh.new()
	cq.size = Vector2(pw, ph * 0.5)
	cl.mesh = cq
	cl.material_override = _cloud_mat
	cl.position = Vector3(0, ph * 0.25, -0.009)
	add_child(cl)
	# glass with a faint reflection
	var gl := MeshInstance3D.new()
	var gq := QuadMesh.new()
	gq.size = Vector2(pw, ph)
	gl.mesh = gq
	var gm := StandardMaterial3D.new()
	gm.albedo_color = Color(0.85, 0.92, 1.0, 0.1)
	gm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	gm.metallic = 0.0
	gm.roughness = 0.25
	gm.metallic_specular = 0.15
	gl.material_override = gm
	gl.position.z = -0.004
	add_child(gl)
	# white aluminium frame: sides, top, bottom, the outer side doubled as the shared mullion's half
	var fm := _mat(Color("eef0f2"))
	fm.roughness = 0.35
	fm.metallic = 0.3
	for e in [[Vector3(-pw / 2, 0, -0.005), Vector3(0.035, ph + 0.07, 0.03)], [Vector3(pw / 2, 0, -0.005), Vector3(0.035, ph + 0.07, 0.03)],
			[Vector3(0, ph / 2, -0.005), Vector3(pw + 0.07, 0.035, 0.03)], [Vector3(0, -ph / 2, -0.005), Vector3(pw + 0.07, 0.035, 0.03)]]:
		var bx := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = e[1]
		bx.mesh = bm
		bx.material_override = fm
		bx.position = e[0]
		add_child(bx)
	var sill := MeshInstance3D.new()
	var sm := BoxMesh.new()
	sm.size = Vector3(pw + 0.1, 0.03, 0.06)
	sill.mesh = sm
	sill.material_override = fm
	sill.position = Vector3(0, -ph / 2 - 0.03, 0.0)
	add_child(sill)


## The curtain in front of this window (the zone's roller curtain), found once.
func _window_curtain() -> DeviceFx:
	if _curtain and is_instance_valid(_curtain):
		return _curtain
	# the room can have more than one roller shade: a window pane is behind the one nearest to it
	var best := INF
	for n in get_tree().get_nodes_in_group("zone_curtain"):
		if n is DeviceFx and n._room_key == _room_key:
			var dist := global_position.distance_to((n as Node3D).global_position)
			if dist < best:
				best = dist
				_curtain = n
	return _curtain


var _backlight := {}  # curtain: window light levels behind it


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
	if variant == "cassette":  # four-way ceiling cassette: air falls from all sides of the grille
		_flap.visible = false
		_air.position = Vector3(0, -size.y * 0.6, 0)
		_air.emission_shape = CPUParticles3D.EMISSION_SHAPE_RING
		_air.emission_ring_axis = Vector3.UP
		_air.emission_ring_radius = size.x * 0.38
		_air.emission_ring_inner_radius = size.x * 0.3
		_air.emission_ring_height = 0.01
		_air.direction = Vector3(0, -1, 0)
		_air.spread = 35.0
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
	if variant == "projector" or variant == "curtain":
		_slats = MeshInstance3D.new()
		var pm := BoxMesh.new()
		pm.size = Vector3(size.x * 0.96, 1.0, 0.008)
		_slats.mesh = pm
		var scr := _mat(Color("f6f3ec"), true)
		scr.emission = Color(1.0, 0.94, 0.82) if variant == "curtain" else Color(0.85, 0.9, 1.0)
		if variant == "curtain":
			add_to_group("zone_curtain")
			var img := Image.create(64, 64, false, Image.FORMAT_RGB8)
			for yy in 64:
				for xx in 64:
					var v := 0.93 + 0.05 * (1 if (xx + yy) % 4 < 2 else 0) - (0.06 if yy % 16 == 0 else 0.0)
					img.set_pixel(xx, yy, Color(v, v, v * 0.98))
			img.generate_mipmaps()
			scr.albedo_texture = ImageTexture.create_from_image(img)
			scr.emission_texture = scr.albedo_texture
			scr.uv1_scale = Vector3(6, 4, 1)
		scr.emission_energy_multiplier = 0.0
		_slats.material_override = scr
		add_child(_slats)
		var housing := MeshInstance3D.new()
		var hb := BoxMesh.new()
		hb.size = Vector3(size.x, 0.1, 0.1)
		housing.mesh = hb
		housing.material_override = _mat(Color("e9e6df"))
		housing.position = Vector3(0, 0.03, 0)
		add_child(housing)
		return
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
