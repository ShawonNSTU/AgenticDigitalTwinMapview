class_name Climate
extends Node3D
## Climate Vision: the air in one room made visible. A small simulation of temperature and fine dust (PM2.5) on a
## 3D grid over the room, driven by the room's real devices (the AC's power, set point and fan; the purifier's power
## and fan; how far the blinds are open; the time of day), drawn three ways:
##   heat     a see-through volume, ray-marched per pixel through the temperature grid and stopped by furniture
##            (scene depth): blue where the air is cold, clear where it is comfortable, red where it is hot
##   airflow  streaks carried by the air at its real speed, coloured by the temperature they are in; the AC blows
##            from its four louvres along the ceiling, down the walls and back across the floor (normal), or seeps
##            gently through its panel (WindFree: no draft)
##   dust     a haze and drifting particles from a smoke source, drawn in and cleaned by the purifier
## The heat and dust fields run as a time-lapse (each step is STEP_S seconds of air time; the panel says how much
## time has passed); the streaks move in real time.

signal readings(r: Dictionary)

const CELL := 0.25            # grid spacing, metres
const STEP_S := 3.0           # air time per simulation step, seconds
const STEPS_PER_S := 8.0      # simulation steps per real second at speed 1
const T_LO := 16.0            # colour scale, °C
const T_HI := 34.0
const PM_MAX := 150.0         # µg/m³ at full haze
const COMFORT := Vector2(22.0, 26.0)

# what the room is
var room_key := ""
var lo := Vector3.ZERO        # inner box of the room (floor at y = 0)
var size := Vector3.ONE
var nx := 1
var ny := 1
var nz := 1
var ac_pos := Vector3.INF     # ceiling cassette
var pur_pos := Vector3.INF    # purifier (floor)
var window_z := INF           # the window wall's z and its span along x
var window_x := Vector2.ZERO
var seats: Array[Vector3] = []   # where people sit (heat)
var ids := {"ac": "", "purifier": "", "blinds": "", "temphum": ""}

# settings (from the page)
var show_heat := true
var show_air := true
var show_dust := true
var windfree := false
var speed := 1.0
var people := 2
var smoke_left := 0.0         # seconds of smoke still to come

# state
var T := PackedFloat32Array()
var P := PackedFloat32Array()
var _T2 := PackedFloat32Array()
var _P2 := PackedFloat32Array()
var _src_i := PackedInt32Array()     # per cell: the 8 cells its air came from one step ago, and their weights
var _src_w := PackedFloat32Array()
var _vel_key := ""
var sim_time := 0.0
var _room_t := 29.0          # the occupied air's mean, for the thermostat
var _load := 1.0             # how hard the AC works (an inverter eases off near its set point)
var _prof_ms := 0.0
var prof := {"step": 0.0, "upload": 0.0, "streaks": 0.0, "dust": 0.0, "flow": 0.0}
var _acc := 0.0
var _out_t := 0.0

# drawing
var _tex: ImageTexture3D
var _vol: MeshInstance3D
var _streaks: MultiMeshInstance3D
var _dots: MultiMeshInstance3D
var _probes: Array[Label3D] = []
var _probe_at: Array[Vector3] = []
var _probe_names: Array[String] = []
var _sp := PackedVector3Array()      # streak positions
var _sa := PackedFloat32Array()      # streak ages
var _dp := PackedVector3Array()      # dust positions
var _dl := PackedFloat32Array()      # dust life (0 = free slot)
var _rng := RandomNumberGenerator.new()

const N_STREAKS := 1600
const N_DUST := 900


## Builds the climate of a room: its box, its devices and seats, the starting air (warm, as after a hot afternoon
## with the AC off), and the drawing.
func setup(room: Dictionary, devices: Array, furniture: Array, ceiling: float) -> void:
	room_key = str(room.get("key", ""))
	var rx: Array = room.x
	var rz: Array = room.z
	lo = Vector3(float(rx[0]) + 0.1, 0.0, float(rz[0]) + 0.1)
	size = Vector3(float(rx[1]) - float(rx[0]) - 0.2, ceiling, float(rz[1]) - float(rz[0]) - 0.2)
	nx = maxi(4, int(round(size.x / CELL)))
	ny = maxi(4, int(round(size.y / CELL)))
	nz = maxi(4, int(round(size.z / CELL)))
	for d in devices:
		if str(d.get("room", "")) != room_key:
			continue
		var p: Array = d.get("position", [0, 0, 0])
		var at := Vector3(float(p[0]), float(p[1]), float(p[2]))
		match str(d.type):
			"ac":
				if ids.ac == "":
					ids.ac = str(d.id)
					ac_pos = Vector3(at.x, ceiling, at.z)
			"purifier":
				ids.purifier = str(d.id)
				pur_pos = Vector3(at.x, 0.0, at.z)
			"blinds":
				ids.blinds = str(d.id)
				window_z = float(rz[0]) if absf(at.z - float(rz[0])) < absf(at.z - float(rz[1])) else float(rz[1])
				window_x = Vector2(at.x - 1.4, at.x + 1.4)
			"temphum":
				ids.temphum = str(d.id)
	if ac_pos == Vector3.INF:
		ac_pos = Vector3(lo.x + size.x / 2, ceiling, lo.z + size.z / 2)
	# people: on the sofa and at the desk chairs
	for f in furniture:
		var c := Vector3(float(f.x), 0, float(f.z))
		if c.x < lo.x or c.x > lo.x + size.x or c.z < lo.z or c.z > lo.z + size.z:
			continue
		match str(f.kind):
			"tufted_sofa", "sofa":
				seats.append(c + Vector3(0, 0.8, 0))
			"mesh_chair", "task_chair", "chair":
				seats.append(c + Vector3(0, 0.9, 0))
	_rng.seed = 7
	reset()
	_weights()
	_build_drawing()
	_add_probes(furniture)


## The air as it is when you walk in on a hot afternoon with the AC off: warm, warmer under the ceiling, a little
## dust.
func reset() -> void:
	var n := nx * ny * nz
	T.resize(n)
	P.resize(n)
	_T2.resize(n)
	_P2.resize(n)
	for k in ny:
		for i in nx:
			for j in nz:
				var id := _idx(i, k, j)
				T[id] = 29.0 + 1.6 * float(k) / ny
				P[id] = 10.0
	sim_time = 0.0
	smoke_left = 0.0
	_vel_key = ""
	for i in _dl.size():
		_dl[i] = 0.0


func _weights() -> void:
	var n := nx * ny * nz
	# (packed arrays are values: each is sized on its own)
	_w_bound.resize(n)
	_w_bound.fill(0.0)
	_w_sun.resize(n)
	_w_sun.fill(0.0)
	_w_acn.resize(n)
	_w_acn.fill(0.0)
	_w_acw.resize(n)
	_w_acw.fill(0.0)
	_w_pur.resize(n)
	_w_pur.fill(0.0)
	_w_smoke.resize(n)
	_w_smoke.fill(0.0)
	_nb.resize(n * 6)
	_w_seat.clear()
	for s in seats:
		var w := PackedFloat32Array()
		w.resize(n)
		w.fill(0.0)
		_w_seat.append(w)
	var smoke_at := smoke_spot()
	for si in seats.size():
		var w := _w_seat[si]
		for c in n:
			var sd := _pos_of(c).distance_squared_to(seats[si])
			if sd < 0.45:
				w[c] = 0.05 * (1.0 - sd / 0.45)
		_w_seat[si] = w
	for j in nz:
		for k in ny:
			for i in nx:
				var c := _idx(i, k, j)
				var pos := _cell_pos(i, k, j)
				_nb[c * 6] = _idx(mini(i + 1, nx - 1), k, j)
				_nb[c * 6 + 1] = _idx(maxi(i - 1, 0), k, j)
				_nb[c * 6 + 2] = _idx(i, mini(k + 1, ny - 1), j)
				_nb[c * 6 + 3] = _idx(i, maxi(k - 1, 0), j)
				_nb[c * 6 + 4] = _idx(i, k, mini(j + 1, nz - 1))
				_nb[c * 6 + 5] = _idx(i, k, maxi(j - 1, 0))
				if i == 0 or j == 0 or i == nx - 1 or j == nz - 1 or k == ny - 1:
					_w_bound[c] = 1.0
				if window_z != INF and pos.x > window_x.x and pos.x < window_x.y:
					if absf(pos.z - window_z) < 0.7:
						_w_sun[c] += 0.09
					if k <= 1 and absf(pos.z - window_z) < 2.0:
						_w_sun[c] += 0.035

				var dx := pos.x - ac_pos.x
				var dz := pos.z - ac_pos.z
				var dd := sqrt(dx * dx + dz * dz)
				if k >= ny - 2:
					if dd < 0.8:
						_w_acw[c] = 0.16
					if dd > 0.35 and dd < 0.95 and (absf(dx) < 0.3 or absf(dz) < 0.3):
						_w_acn[c] = 0.55
				if pur_pos != Vector3.INF and Vector2(pos.x - pur_pos.x, pos.z - pur_pos.z).length() < 0.9 and pos.y < 1.2:
					_w_pur[c] = 0.45
				var sm := pos.distance_squared_to(smoke_at)
				if sm < 0.6:
					_w_smoke[c] = 320.0 * (1.0 - sm / 0.6)


func smoke_spot() -> Vector3:
	return Vector3(lo.x + size.x * 0.28, 0.9, lo.z + size.z * 0.55)


## Air velocity at a point from the stored grid (trilinear), for the particles.
func vel_at(p: Vector3) -> Vector3:
	if _vg.is_empty():
		return Vector3.ZERO
	var g := ((p - lo) / CELL - Vector3(0.5, 0.5, 0.5)).clamp(Vector3.ZERO, Vector3(nx - 1.001, ny - 1.001, nz - 1.001))
	var i0 := int(g.x)
	var k0 := int(g.y)
	var j0 := int(g.z)
	var f := g - Vector3(i0, k0, j0)
	var c := _idx(i0, k0, j0)
	var sx := 1
	var sy := nx
	var sz := nx * ny
	var a := _vg[c].lerp(_vg[c + sx], f.x)
	var b := _vg[c + sy].lerp(_vg[c + sy + sx], f.x)
	var e := _vg[c + sz].lerp(_vg[c + sz + sx], f.x)
	var d := _vg[c + sz + sy].lerp(_vg[c + sz + sy + sx], f.x)
	return a.lerp(b, f.y).lerp(e.lerp(d, f.y), f.z)


func _idx(i: int, k: int, j: int) -> int:
	return (j * ny + k) * nx + i


# ---------------- the air's movement ----------------

func _live(id: String) -> Dictionary:
	if id == "":
		return {}
	if Store.live.has(id):
		return Store.live[id]
	var d = Store.device(id)
	return d.get("live", {}) if d is Dictionary else {}


func ac_on() -> bool:
	return bool(_live(ids.ac).get("on", false))


func purifier_on() -> bool:
	return bool(_live(ids.purifier).get("on", false))


## Air velocity (m/s) at a point, from the AC (four louvre jets along the ceiling that turn down the walls and come
## back across the floor to the return grille; or a slow seep in WindFree), the purifier (drawing air in low and
## blowing it up) and a little convection.
func vel(p: Vector3) -> Vector3:
	var v := Vector3.ZERO
	var H := size.y
	var h := clampf(p.y / H, 0.0, 1.0)
	if ac_on():
		var fan := clampf(float(_live(ids.ac).get("fan", 60)) / 100.0, 0.2, 1.0)
		var r := Vector2(p.x - ac_pos.x, p.z - ac_pos.z)
		var d := r.length()
		if windfree:
			# through thousands of micro-holes: a slow fall of cool air under the panel that spreads gently
			var s := 0.16 * fan
			v += Vector3(0, -s * exp(-d * d / 4.0), 0)
			if d > 0.01:
				var dir := r / d
				v += Vector3(dir.x, 0, dir.y) * s * 0.5 * (1.0 - h) * minf(d, 1.5)
		else:
			var s := 1.4 * fan
			if d > 0.01:
				# four louvres: the jets leave along the cassette's axes, so the flow is strongest along them
				var dir := r / d
				var axis := maxf(absf(dir.x), absf(dir.y))
				var along := dir if axis > 0.92 else (Vector2(signf(dir.x), 0) if absf(dir.x) > absf(dir.y) else Vector2(0, signf(dir.y)))
				along = along.lerp(dir, 0.35).normalized()
				# distance left to the wall the jet is heading for
				var wall := _to_wall(Vector2(p.x, p.z), along)
				var jet := smoothstep(0.62, 0.92, h) * clampf(1.1 - d * 0.12, 0.25, 1.0)
				var fall := smoothstep(0.9, 0.2, wall)                       # near the wall: turning down
				var back := smoothstep(0.32, 0.05, h)                         # along the floor: coming back
				v += Vector3(along.x, 0, along.y) * s * (jet * (1.0 - fall) - 0.45 * back)
				v.y -= s * 0.75 * fall * smoothstep(0.05, 0.3, h)
				v.y += s * 0.55 * smoothstep(1.4, 0.2, d) * (1.0 - smoothstep(0.85, 0.95, h)) * smoothstep(0.1, 0.4, h)   # rising to the return
				v -= Vector3(along.x, 0, along.y) * s * 0.18 * smoothstep(0.35, 0.6, h) * (1.0 - smoothstep(0.6, 0.85, h))
	if purifier_on() and pur_pos != Vector3.INF:
		var fanp := clampf(float(_live(ids.purifier).get("fan", 2)) / 4.0, 0.25, 1.0)
		var q := Vector3(pur_pos.x - p.x, 0, pur_pos.z - p.z)
		var dq := q.length()
		if dq > 0.05:
			var pull := 0.5 * fanp * exp(-dq * dq / 1.6) * smoothstep(1.0, 0.2, p.y)
			v += q / dq * pull
		v.y += 0.9 * fanp * exp(-dq * dq / 0.15) * smoothstep(0.4, 0.8, p.y)
	return v


func _to_wall(p: Vector2, d: Vector2) -> float:
	var t := INF
	if d.x > 0.001:
		t = minf(t, (lo.x + size.x - p.x) / d.x)
	elif d.x < -0.001:
		t = minf(t, (lo.x - p.x) / d.x)
	if d.y > 0.001:
		t = minf(t, (lo.z + size.z - p.y) / d.y)
	elif d.y < -0.001:
		t = minf(t, (lo.z - p.y) / d.y)
	return t


## Where each cell's air was one step ago, worked out once per airflow (the flow only changes when the devices do):
## then every step moves the whole field with one weighted sum per cell.
var _vg := PackedVector3Array()      # air velocity at each cell (for the particles)
var _job_v := PackedVector3Array()
# per-cell weights of what heats, cools or dirties the air there, worked out once
var _nb := PackedInt32Array()        # 6 neighbours per cell (itself at the room's edge)
var _w_bound := PackedFloat32Array() # walls and roof: heat coming in
var _w_sun := PackedFloat32Array()   # sun through the window, and its patch on the floor
var _w_acn := PackedFloat32Array()   # the AC's louvres (normal)
var _w_acw := PackedFloat32Array()   # the AC's panel (WindFree)
var _w_pur := PackedFloat32Array()   # the purifier's intake
var _w_smoke := PackedFloat32Array() # the smoke spot
var _w_seat: Array[PackedFloat32Array] = []   # one per seat
var _job_key := ""
var _job_next := 0
var _job_i := PackedInt32Array()
var _job_w := PackedFloat32Array()


## Works the new flow out a slab at a time over a few frames (no stall when a device changes); the old flow keeps
## carrying the air until the new one is ready.
func _prepare_flow() -> void:
	var key := "%s|%s|%s|%s|%s" % [ac_on(), windfree, _live(ids.ac).get("fan", 60), purifier_on(), _live(ids.purifier).get("fan", 2)]
	var n := nx * ny * nz
	if _src_i.size() != n * 8:
		_src_i.resize(n * 8)
		_src_w.resize(n * 8)
		_vg.resize(n)
		for c in n:
			_src_i[c * 8] = c
			_src_w[c * 8] = 1.0
	if key == _vel_key and _job_key == "":
		return
	if key != _job_key:
		_job_key = key
		_job_next = 0
		_job_i.resize(n * 8)
		_job_w.resize(n * 8)
		_job_v.resize(n)
	var dt := STEP_S * 0.35   # how far air is carried between steps, in seconds of its speed (eases the smear)
	var stop := mini(_job_next + 4, nz)
	for j in range(_job_next, stop):
		for k in ny:
			for i in nx:
				var c := _cell_pos(i, k, j)
				var vv := vel(c)
				_job_v[_idx(i, k, j)] = vv
				var b := c - vv * dt
				var g := (b - lo) / CELL - Vector3(0.5, 0.5, 0.5)
				g = g.clamp(Vector3.ZERO, Vector3(nx - 1.001, ny - 1.001, nz - 1.001))
				var i0 := int(g.x)
				var k0 := int(g.y)
				var j0 := int(g.z)
				var f := g - Vector3(i0, k0, j0)
				var base := _idx(i, k, j) * 8
				var m := 0
				for dj in 2:
					for dk in 2:
						for di in 2:
							_job_i[base + m] = _idx(mini(i0 + di, nx - 1), mini(k0 + dk, ny - 1), mini(j0 + dj, nz - 1))
							_job_w[base + m] = (f.x if di else 1.0 - f.x) * (f.y if dk else 1.0 - f.y) * (f.z if dj else 1.0 - f.z)
							m += 1
	_job_next = stop
	if _job_next >= nz:
		_src_i = _job_i.duplicate()
		_src_w = _job_w.duplicate()
		_vg = _job_v.duplicate()
		_vel_key = _job_key
		_job_key = ""


func _pos_of(c: int) -> Vector3:
	return _cell_pos(c % nx, (c / nx) % ny, c / (nx * ny))


func _cell_pos(i: int, k: int, j: int) -> Vector3:
	return lo + Vector3((i + 0.5) * CELL, (k + 0.5) * CELL, (j + 0.5) * CELL)


# ---------------- one step of the air ----------------

func _hour() -> float:
	var t := Time.get_datetime_dict_from_system()
	return float(t.hour) + float(t.minute) / 60.0


var _phase := 0      # 0: carry the air, 1: heat, cool and clean it
var _cur := 0


## One step of the air, spread over a few frames (a slice of the cells each frame), so no frame takes the whole step.
## Returns true when a step has finished.
func _step_some(cells: int) -> bool:
	var n := nx * ny * nz
	if _phase == 0:
		if _cur == 0:
			_prepare_flow()
		var stop := mini(_cur + cells, n)
		for c in range(_cur, stop):
			var b := c * 8
			_T2[c] = T[_src_i[b]] * _src_w[b] + T[_src_i[b + 1]] * _src_w[b + 1] + T[_src_i[b + 2]] * _src_w[b + 2] + T[_src_i[b + 3]] * _src_w[b + 3] \
				+ T[_src_i[b + 4]] * _src_w[b + 4] + T[_src_i[b + 5]] * _src_w[b + 5] + T[_src_i[b + 6]] * _src_w[b + 6] + T[_src_i[b + 7]] * _src_w[b + 7]
			_P2[c] = P[_src_i[b]] * _src_w[b] + P[_src_i[b + 1]] * _src_w[b + 1] + P[_src_i[b + 2]] * _src_w[b + 2] + P[_src_i[b + 3]] * _src_w[b + 3] \
				+ P[_src_i[b + 4]] * _src_w[b + 4] + P[_src_i[b + 5]] * _src_w[b + 5] + P[_src_i[b + 6]] * _src_w[b + 6] + P[_src_i[b + 7]] * _src_w[b + 7]
		_cur = stop
		if _cur >= n:
			_cur = 0
			_phase = 1
		return false
	var stop2 := mini(_cur + cells, n)
	_sources(_cur, stop2)
	_cur = stop2
	if _cur < n:
		return false
	_cur = 0
	_phase = 0
	_finish_step()
	return true


func _sources(from: int, to: int) -> void:
	var on := ac_on()
	var ac := _live(ids.ac)
	var set_t := float(ac.get("set", 24))
	var supply := set_t - (8.0 if not windfree else 6.0)
	# an inverter AC eases off as the room nears its set point (and stops just below it)
	_load = clampf((_room_t - (set_t - 0.4)) / 1.6, 0.05, 1.0) if on else 0.0
	var fan := clampf(float(ac.get("fan", 60)) / 100.0, 0.2, 1.0) * _load
	var blinds := clampf(float(_live(ids.blinds).get("pos", 100)) / 100.0, 0.0, 1.0)
	var h := _hour()
	var sun := clampf(sin((h - 6.0) / 12.0 * PI), 0.0, 1.0) * blinds
	var purk := (0.0 if not purifier_on() else clampf(float(_live(ids.purifier).get("fan", 2)) / 4.0, 0.25, 1.0))
	var smoke := 1.0 if smoke_left > 0.0 else 0.0
	var wac := _w_acw if windfree else _w_acn
	var acf := fan if on else 0.0
	var np := mini(people, _w_seat.size())
	for c in range(from, to):
		var b6 := c * 6
		var t := _T2[c]
		var p := _P2[c]
		# mixing with the neighbours, and warm air rising from below
		var avg := (_T2[_nb[b6]] + _T2[_nb[b6 + 1]] + _T2[_nb[b6 + 2]] + _T2[_nb[b6 + 3]] + _T2[_nb[b6 + 4]] + _T2[_nb[b6 + 5]]) / 6.0
		t += 0.16 * (avg - t)
		var below := _T2[_nb[b6 + 3]]
		if below > t:
			t += 0.06 * (below - t)
		p += 0.2 * ((_P2[_nb[b6]] + _P2[_nb[b6 + 1]] + _P2[_nb[b6 + 2]] + _P2[_nb[b6 + 3]] + _P2[_nb[b6 + 4]] + _P2[_nb[b6 + 5]]) / 6.0 - p)
		# heat in through the walls (31 °C outside) and the sun through the window
		t += 0.004 * _w_bound[c] * (31.0 - t) + _w_sun[c] * sun
		for si in np:
			t += _w_seat[si][c]
		# the AC's cold supply
		t += wac[c] * acf * (supply - t)
		# dust: the smoke spot, the purifier's intake, slow settling
		p = (p + _w_smoke[c] * smoke) * (1.0 - _w_pur[c] * purk) * 0.9985
		T[c] = t
		P[c] = maxf(p, 0.0)


func _finish_step() -> void:
	sim_time += STEP_S
	if smoke_left > 0.0:
		smoke_left -= STEP_S
	# the thermostat reads the occupied air (cheap: every 4th cell up to 1.8 m)
	var sum := 0.0
	var cnt := 0
	var kmax := mini(ny, int(1.8 / CELL))
	for j in range(0, nz, 2):
		for k in range(0, kmax, 2):
			for i in range(0, nx, 2):
				sum += T[_idx(i, k, j)]
				cnt += 1
	_room_t = sum / maxf(cnt, 1.0)


# ---------------- drawing ----------------

const VOLUME_SHADER := """
shader_type spatial;
render_mode unshaded, cull_front, depth_draw_never, depth_test_disabled, blend_mix, shadows_disabled;

uniform sampler3D field : filter_linear, repeat_disable;
uniform sampler2D depth_tex : hint_depth_texture, filter_nearest;
uniform vec3 box_min;
uniform vec3 box_size;
uniform float heat_on = 1.0;
uniform float dust_on = 1.0;
uniform float heat_strength = 0.9;
uniform float dust_strength = 3.2;
uniform vec2 comfort = vec2(0.333, 0.556);   // 22 and 26 °C on the 16-34 scale

varying vec3 wpos;

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

// cold blue, clear when comfortable, warm orange to hot red
vec4 heat(float t) {
	// cool air shows from 24 °C down (light blue), deep blue by 17 °C
	float cold = clamp((comfort.x + 0.111 - t) / 0.39, 0.0, 1.0);
	float hot = clamp((t - comfort.y) / (1.0 - comfort.y), 0.0, 1.0);
	vec3 c = mix(vec3(0.2, 0.62, 1.0), vec3(0.05, 0.22, 1.0), cold);
	vec3 w = mix(vec3(1.0, 0.75, 0.25), vec3(1.0, 0.15, 0.08), hot);
	float a = max(cold * 0.75 + cold * cold * 1.2, hot);
	vec3 col = cold > hot ? c : w;
	// a faint tint inside the comfort band so the cool spreading front is visible
	float mid = (t - comfort.x) / (comfort.y - comfort.x);
	if (cold < 0.02 && hot == 0.0) { col = mix(vec3(0.6, 0.95, 1.0), vec3(1.0, 0.9, 0.5), mid); a = 0.035; }
	return vec4(col, a);
}

void fragment() {
	vec3 ro = (INV_VIEW_MATRIX * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
	vec3 rd = normalize(wpos - ro);
	vec3 inv = 1.0 / rd;
	vec3 ta = (box_min - ro) * inv;
	vec3 tb = (box_min + box_size - ro) * inv;
	vec3 tmn = min(ta, tb);
	vec3 tmx = max(ta, tb);
	float tn = max(max(tmn.x, tmn.y), max(tmn.z, 0.0));
	float tf = min(min(tmx.x, tmx.y), tmx.z);
	// stop where the scene is: furniture and people in front of the air hide what is behind them
	float d = texture(depth_tex, SCREEN_UV).r;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	vec3 ndc = vec3(SCREEN_UV * 2.0 - 1.0, d * 2.0 - 1.0);
#else
	vec3 ndc = vec3(SCREEN_UV * 2.0 - 1.0, d);
#endif
	vec4 v = INV_PROJECTION_MATRIX * vec4(ndc, 1.0);
	v.xyz /= v.w;
	tf = min(tf, length(v.xyz));
	if (tf <= tn) { discard; }
	const int STEPS = 40;
	float dt = (tf - tn) / float(STEPS);
	float jit = fract(sin(dot(FRAGCOORD.xy, vec2(12.9898, 78.233))) * 43758.5453);
	vec3 acc = vec3(0.0);
	float a = 0.0;
	for (int i = 0; i < STEPS; i++) {
		vec3 p = ro + rd * (tn + (float(i) + jit) * dt);
		vec4 f = texture(field, (p - box_min) / box_size);
		vec4 h = heat(f.r);
		float ah = heat_on * heat_strength * h.a * dt;
		float ad = dust_on * dust_strength * smoothstep(0.08, 0.6, f.g) * dt;
		vec3 col = (h.rgb * ah + mix(vec3(0.7, 0.66, 0.6), vec3(0.42, 0.38, 0.34), f.g) * ad) / max(ah + ad, 1e-4);
		float s = clamp(ah + ad, 0.0, 1.0);
		acc += (1.0 - a) * col * s;
		a += (1.0 - a) * s;
		if (a > 0.92) { break; }
	}
	if (a < 0.003) { discard; }
	ALBEDO = acc / a;
	ALPHA = a;
}
"""


func _build_drawing() -> void:
	# the volume: a box over the room drawn from inside out, so it works with the camera in or out of the room
	var imgs: Array[Image] = []
	for j in nz:
		imgs.append(Image.create(nx, ny, false, Image.FORMAT_RGBA8))
	_tex = ImageTexture3D.new()
	_tex.create(Image.FORMAT_RGBA8, nx, ny, nz, false, imgs)
	var box := BoxMesh.new()
	box.size = size
	_vol = MeshInstance3D.new()
	_vol.name = "HeatVolume"
	_vol.mesh = box
	_vol.position = lo + size / 2
	_vol.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var sm := ShaderMaterial.new()
	var sh := Shader.new()
	sh.code = VOLUME_SHADER
	sm.shader = sh
	sm.set_shader_parameter("field", _tex)
	sm.set_shader_parameter("box_min", lo)
	sm.set_shader_parameter("box_size", size)
	sm.set_shader_parameter("comfort", Vector2((COMFORT.x - T_LO) / (T_HI - T_LO), (COMFORT.y - T_LO) / (T_HI - T_LO)))
	sm.render_priority = 5
	_vol.material_override = sm
	add_child(_vol)
	# airflow streaks: thin glowing dashes laid along the air's direction
	var dash := BoxMesh.new()
	dash.size = Vector3(0.012, 0.012, 1.0)
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.mesh = dash
	mm.instance_count = N_STREAKS
	_streaks = MultiMeshInstance3D.new()
	_streaks.name = "Airflow"
	_streaks.multimesh = mm
	var smat := StandardMaterial3D.new()
	smat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	smat.vertex_color_use_as_albedo = true
	smat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	smat.render_priority = 6
	_streaks.material_override = smat
	_streaks.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_streaks)
	_sp.resize(N_STREAKS)
	_sa.resize(N_STREAKS)
	for i in N_STREAKS:
		_sp[i] = _spawn_streak()
		_sa[i] = _rng.randf_range(0.0, 6.0)
	# dust motes
	var mote := SphereMesh.new()
	mote.radius = 0.018
	mote.height = 0.036
	mote.radial_segments = 6
	mote.rings = 3
	var dm := MultiMesh.new()
	dm.transform_format = MultiMesh.TRANSFORM_3D
	dm.use_colors = true
	dm.mesh = mote
	dm.instance_count = N_DUST
	_dots = MultiMeshInstance3D.new()
	_dots.name = "Dust"
	_dots.multimesh = dm
	var dmat := StandardMaterial3D.new()
	dmat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	dmat.vertex_color_use_as_albedo = true
	dmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	dmat.render_priority = 6
	_dots.material_override = dmat
	_dots.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_dots)
	_dp.resize(N_DUST)
	_dl.resize(N_DUST)
	for i in N_DUST:
		_dl[i] = 0.0
		_dp[i] = Vector3.ZERO
	_upload()


## Temperature probes where people are: the sofa, the desk and the window.
func _add_probes(furniture: Array) -> void:
	var spots := []
	for f in furniture:
		var c := Vector3(float(f.x), 1.15, float(f.z))
		if c.x < lo.x or c.x > lo.x + size.x or c.z < lo.z or c.z > lo.z + size.z:
			continue
		if str(f.kind) == "tufted_sofa":
			spots.append(["Sofa", c])
		elif str(f.kind) == "desk_one":
			spots.append(["Desk", c])
	if window_z != INF:
		spots.append(["Window", Vector3((window_x.x + window_x.y) / 2, 1.15, window_z + (0.6 if window_z < lo.z + size.z / 2 else -0.6))])
	for s in spots:
		var l := Label3D.new()
		l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		l.no_depth_test = true
		l.fixed_size = true
		l.pixel_size = 0.0011
		l.font_size = 30
		l.outline_size = 12
		l.outline_modulate = Color(0.04, 0.06, 0.1, 0.95)
		l.render_priority = 20
		l.outline_render_priority = 19
		l.position = s[1]
		add_child(l)
		_probes.append(l)
		_probe_at.append(s[1])
		_probe_names.append(s[0])


func sample_t(p: Vector3) -> float:
	var g := ((p - lo) / CELL - Vector3(0.5, 0.5, 0.5)).clamp(Vector3.ZERO, Vector3(nx - 1, ny - 1, nz - 1))
	return T[_idx(int(round(g.x)), int(round(g.y)), int(round(g.z)))]


func _spawn_streak() -> Vector3:
	if ac_on():
		var r := _rng.randf_range(0.42, 0.62) if not windfree else _rng.randf_range(0.0, 0.55)
		if windfree:
			var a := _rng.randf() * TAU
			return Vector3(ac_pos.x + cos(a) * r, size.y - 0.08, ac_pos.z + sin(a) * r)
		var side := _rng.randi() % 4
		var along := _rng.randf_range(-0.42, 0.42)
		var o := [Vector2(r, along), Vector2(-r, along), Vector2(along, r), Vector2(along, -r)][side] as Vector2
		return Vector3(ac_pos.x + o.x, size.y - 0.06, ac_pos.z + o.y)
	# AC off: a few lazy streaks anywhere (warm air barely moving)
	return lo + Vector3(_rng.randf() * size.x, _rng.randf() * size.y, _rng.randf() * size.z)


func _heat_color(t: float) -> Color:
	var k := clampf((t - T_LO) / (T_HI - T_LO), 0.0, 1.0)
	var stops := [[0.0, Color(0.15, 0.35, 1.0)], [0.25, Color(0.25, 0.75, 1.0)], [0.42, Color(0.75, 0.98, 1.0)], [0.6, Color(1.0, 0.85, 0.35)], [1.0, Color(1.0, 0.2, 0.1)]]
	for s in range(1, stops.size()):
		if k <= stops[s][0]:
			var a = stops[s - 1]
			var b = stops[s]
			return (a[1] as Color).lerp(b[1], (k - a[0]) / (b[0] - a[0]))
	return stops[-1][1]


func _process(delta: float) -> void:
	if not visible:
		return
	var t0 := Time.get_ticks_usec()
	# the air's own time, as a time-lapse
	var a0 := Time.get_ticks_usec()
	# a step's two passes over the cells, spread over frames: the faster the time-lapse, the more cells a frame
	var n := nx * ny * nz
	var per_frame := int(ceil(2.0 * n * STEPS_PER_S * speed * delta))
	var done := _step_some(clampi(per_frame, 256, n))
	var a1 := Time.get_ticks_usec()
	if done:
		_upload()
	var a2 := Time.get_ticks_usec()
	_move_streaks(delta)
	var a3 := Time.get_ticks_usec()
	_move_dust(delta)
	var a4 := Time.get_ticks_usec()
	prof.step = lerpf(prof.step, (a1 - a0) / 1000.0, 0.05)
	prof.upload = lerpf(prof.upload, (a2 - a1) / 1000.0, 0.05)
	prof.streaks = lerpf(prof.streaks, (a3 - a2) / 1000.0, 0.05)
	prof.dust = lerpf(prof.dust, (a4 - a3) / 1000.0, 0.05)
	_prof_ms = lerpf(_prof_ms, (Time.get_ticks_usec() - t0) / 1000.0, 0.1)
	_out_t -= delta
	if _out_t <= 0.0:
		_out_t = 0.4
		_report()


var _sbuf := PackedFloat32Array()
var _heat_lut := PackedColorArray()


func _move_streaks(delta: float) -> void:
	var mm := _streaks.multimesh
	_streaks.visible = show_air
	if not show_air:
		return
	if _heat_lut.is_empty():
		for q in 64:
			_heat_lut.append(_heat_color(T_LO + (T_HI - T_LO) * q / 63.0))
	if _sbuf.size() != N_STREAKS * 16:
		_sbuf.resize(N_STREAKS * 16)
	var on := ac_on()
	var hi := lo + size
	var life := 7.0 if on else 4.0
	var amax := (0.85 if on else 0.25) * (0.35 + 0.65 * _load if on and not windfree else 1.0)
	var lift := Vector3(0, 0.04, 0) if not on else Vector3.ZERO
	var inv := 1.0 / CELL
	var kt := 63.0 / (T_HI - T_LO)
	for i in N_STREAKS:
		var p := _sp[i]
		var v := vel_at(p) + lift
		var s := v.length()
		p += v * delta
		var age := _sa[i] + delta
		if age > life or s < (0.012 if not windfree else 0.004) or p.x < lo.x or p.z < lo.z or p.x > hi.x or p.z > hi.z or p.y < 0.03 or p.y > size.y:
			p = _spawn_streak()
			age = 0.0
			v = vel_at(p) + lift
			s = v.length()
		_sp[i] = p
		_sa[i] = age
		# a dash along the air: z along the flow, scaled to its speed; x and y any two perpendiculars
		var z := v / s if s > 0.001 else Vector3.UP
		var x := z.cross(Vector3.UP if absf(z.y) < 0.95 else Vector3.RIGHT).normalized()
		var y := x.cross(z)
		z *= clampf(s * (0.22 if not windfree else 1.6), 0.04 if not windfree else 0.1, 0.32)
		var b := i * 16
		_sbuf[b] = x.x; _sbuf[b + 1] = y.x; _sbuf[b + 2] = z.x; _sbuf[b + 3] = p.x
		_sbuf[b + 4] = x.y; _sbuf[b + 5] = y.y; _sbuf[b + 6] = z.y; _sbuf[b + 7] = p.y
		_sbuf[b + 8] = x.z; _sbuf[b + 9] = y.z; _sbuf[b + 10] = z.z; _sbuf[b + 11] = p.z
		var gi := clampi(int((p.x - lo.x) * inv), 0, nx - 1)
		var gk := clampi(int(p.y * inv), 0, ny - 1)
		var gj := clampi(int((p.z - lo.z) * inv), 0, nz - 1)
		var c := _heat_lut[clampi(int((T[gi + nx * (gk + ny * gj)] - T_LO) * kt), 0, 63)]
		_sbuf[b + 12] = c.r; _sbuf[b + 13] = c.g; _sbuf[b + 14] = c.b
		_sbuf[b + 15] = amax * clampf(age * 2.0, 0.0, 1.0) * clampf((7.0 - age) * 0.8, 0.0, 1.0)
	mm.buffer = _sbuf


func _move_dust(delta: float) -> void:
	var mm := _dots.multimesh
	_dots.visible = show_dust
	if not show_dust:
		return
	# as many motes as the dust in the air (each mote stands for a little of it)
	var total := 0.0
	for p in P:
		total += p
	var want := clampi(int((total / P.size() - 10.0) * 14.0), 0, N_DUST)
	var live := 0
	for i in N_DUST:
		if _dl[i] > 0.0:
			live += 1
	var spawn := want - live
	var smoke_at := smoke_spot()
	for i in N_DUST:
		if _dl[i] <= 0.0:
			if spawn > 0:
				spawn -= 1
				_dl[i] = _rng.randf_range(6.0, 14.0)
				var from := smoke_at if smoke_left > 0.0 else lo + Vector3(_rng.randf() * size.x, _rng.randf_range(0.3, size.y), _rng.randf() * size.z)
				_dp[i] = from + Vector3(_rng.randf_range(-0.3, 0.3), _rng.randf_range(-0.2, 0.4), _rng.randf_range(-0.3, 0.3))
			else:
				mm.set_instance_transform(i, Transform3D(Basis.from_scale(Vector3.ZERO), Vector3.ZERO))
				continue
		var p := _dp[i]
		p += (vel_at(p) * 0.8 + Vector3(_rng.randf_range(-0.05, 0.05), 0.02, _rng.randf_range(-0.05, 0.05))) * delta
		_dl[i] -= delta
		# the purifier takes it in
		if purifier_on() and pur_pos != Vector3.INF and Vector2(p.x - pur_pos.x, p.z - pur_pos.z).length() < 0.3 and p.y < 0.8:
			_dl[i] = 0.0
		if live > want + 20 and _rng.randf() < 0.02:
			_dl[i] = 0.0
		_dp[i] = p
		var a := clampf(_dl[i], 0.0, 1.0)
		mm.set_instance_transform(i, Transform3D(Basis.from_scale(Vector3.ONE * (0.7 + 0.6 * a)), p))
		mm.set_instance_color(i, Color(0.55, 0.48, 0.4, 0.55 * a))


## The fields to the GPU: red = temperature, green = dust.
func _upload() -> void:
	var imgs: Array[Image] = []
	var row := PackedByteArray()
	row.resize(nx * ny * 4)
	for j in nz:
		for k in ny:
			for i in nx:
				var c := _idx(i, k, j)
				var o := (k * nx + i) * 4
				row[o] = clampi(int((T[c] - T_LO) / (T_HI - T_LO) * 255.0), 0, 255)
				row[o + 1] = clampi(int(P[c] / PM_MAX * 255.0), 0, 255)
				row[o + 2] = 0
				row[o + 3] = 255
		imgs.append(Image.create_from_data(nx, ny, false, Image.FORMAT_RGBA8, row))
	_tex.update(imgs)
	var sm := _vol.material_override as ShaderMaterial
	sm.set_shader_parameter("heat_on", 1.0 if show_heat else 0.0)
	sm.set_shader_parameter("dust_on", 1.0 if show_dust else 0.0)
	_vol.visible = show_heat or show_dust


## What the panel shows: the air where people are (0.1-1.8 m), how much of it is comfortable, the dust, the
## simulated time; and the probes' labels.
func _report() -> void:
	var sum := 0.0
	var cnt := 0
	var good := 0
	var dust := 0.0
	var kmax := mini(ny, int(1.8 / CELL))
	for j in nz:
		for k in kmax:
			for i in nx:
				var c := _idx(i, k, j)
				sum += T[c]
				dust += P[c]
				cnt += 1
				if T[c] >= COMFORT.x and T[c] <= COMFORT.y:
					good += 1
	var r := {
		"room": room_key, "temp": snappedf(sum / cnt, 0.1), "comfort": int(round(100.0 * good / cnt)), "pm": int(round(dust / cnt)),
		"minutes": snappedf(sim_time / 60.0, 0.1), "ac": ac_on(), "acSet": _live(ids.ac).get("set", null), "windfree": windfree,
		"purifier": purifier_on(), "smoke": smoke_left > 0.0, "people": people, "speed": speed,
		"acLoad": int(round(_load * 100.0)), "cpuMs": snappedf(_prof_ms, 0.1),
		"probes": [], "ids": ids, "fan": _live(ids.ac).get("fan", null), "purFan": _live(ids.purifier).get("fan", null),
		"layers": {"heat": show_heat, "airflow": show_air, "dust": show_dust},
	}
	var cam := get_viewport().get_camera_3d()
	for i in _probes.size():
		var t := sample_t(_probe_at[i])
		# the room's own read-outs: shown when the room fills the view, hidden from far away (they would crowd the floor)
		_probes[i].visible = cam != null and cam.global_position.distance_to(_probes[i].global_position) < 17.0
		_probes[i].text = "%s  %.1f °C" % [_probe_names[i], t]
		_probes[i].modulate = _heat_color(t).lerp(Color.WHITE, 0.35)
		r.probes.append({"name": _probe_names[i], "temp": snappedf(t, 0.1)})
	readings.emit(r)
