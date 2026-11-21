class_name WalkNav
extends RefCounted
## The walkable floor for first-person mode: a grid over the rooms in which walls (with their door gaps),
## columns and furniture are solid, A* paths that go through doorways, and doorways for rooms the plan
## left without one (so every room can be entered).

const RADIUS := 0.22   # body radius: metres kept between the walker's centre and any wall or furniture
const MARGIN := 0.45   # routes prefer to stay this far from obstacles (middle of corridors and doorways)
# only rugs and door leaves (open flat against the wall while walking) can be walked over
const SOFT := ["door", "rug", "exit_sign", "poster"]  # walked over or under (signs and prints hang on the wall)

var astar := AStarGrid2D.new()
var cell := 0.15
var gaps: Array = []        # door openings [a, b]: routes cross them through the middle, square on
var _near := PackedByteArray()  # 1 where a cell is closer than MARGIN to an obstacle
var origin := Vector2.ZERO
var size := Vector2i.ZERO


func build(wall_pieces: Array, door_gaps: Array = []) -> void:
	gaps = door_gaps
	var fr: Rect2 = Store.floor_rect().grow(1.0)
	cell = maxf(0.15, maxf(fr.size.x, fr.size.y) / 700.0)  # at most ~700 cells across, even on huge floors
	origin = fr.position
	size = Vector2i(ceili(fr.size.x / cell) + 1, ceili(fr.size.y / cell) + 1)
	astar.region = Rect2i(Vector2i.ZERO, size)
	astar.cell_size = Vector2.ONE
	astar.diagonal_mode = AStarGrid2D.DIAGONAL_MODE_ONLY_IF_NO_OBSTACLES
	astar.default_compute_heuristic = AStarGrid2D.HEURISTIC_OCTILE
	astar.default_estimate_heuristic = AStarGrid2D.HEURISTIC_OCTILE
	astar.update()
	astar.fill_solid_region(astar.region, true)
	# 1. the rooms are walkable
	for r in Store.rooms:
		if not Store.room_allowed(r.key):
			continue
		var poly := PlanGeo.room_poly(r)
		var bb := _bbox(poly)
		var a := to_cell(bb.position)
		var b := to_cell(bb.end)
		for i in range(a.x, b.x + 1):
			for j in range(a.y, b.y + 1):
				var c := Vector2i(i, j)
				if _inside(c) and Geometry2D.is_point_in_polygon(centre(c), poly):
					astar.set_point_solid(c, false)
	# 2. doorways are walkable on both sides, even where a cell centre falls on the room boundary
	for f in Store.furniture:
		if f.get("kind", "") == "door":
			_fill(Placer._rect(Vector2(float(f.x), float(f.z)), Vector2(float(f.w), 0.7), float(f.get("rot", 0.0))), false)
	# 3. furniture and columns
	for f in Store.furniture:
		if SOFT.has(f.get("kind", "")):
			continue
		_fill(Placer._rect(Vector2(float(f.x), float(f.z)), Vector2(float(f.w) + 2 * RADIUS, float(f.d) + 2 * RADIUS), float(f.get("rot", 0.0))), true)
	# 4. walls, kept RADIUS away, and the open door leaves standing out from their hinges
	for s in wall_pieces:
		_mark_segment(s[0], s[1])
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var rot := float(f.get("rot", 0.0))
		var u := Vector2(cos(rot), -sin(rot))
		var n := Vector2(sin(rot), cos(rot))
		var w := float(f.w)
		var leaves := 2 if w > 1.2 else 1
		for li in leaves:
			var side := -1.0 if li == 0 else 1.0
			var hinge := c + u * side * w / 2
			_mark_segment(hinge, hinge + n * (w / leaves - 0.02))
	_clearance()


func _mark_segment(a: Vector2, b: Vector2) -> void:
	var reach := ceili(RADIUS / cell) + 1
	var steps := maxi(1, ceili(a.distance_to(b) / (cell * 0.5)))
	for k in steps + 1:
		var q := a.lerp(b, float(k) / steps)
		var c0 := to_cell(q)
		for i in range(-reach, reach + 1):
			for j in range(-reach, reach + 1):
				var c := c0 + Vector2i(i, j)
				if _inside(c) and not astar.is_point_solid(c):
					var m := centre(c)
					if m.distance_to(Geometry2D.get_closest_point_to_segment(m, a, b)) < RADIUS:
						astar.set_point_solid(c, true)


## Cells near obstacles cost more, so routes keep to the middle of corridors, aisles and doorways.
func _clearance() -> void:
	var n := size.x * size.y
	var dist := PackedInt32Array()
	dist.resize(n)
	dist.fill(1 << 20)
	var queue := PackedInt32Array()
	for j in size.y:
		for i in size.x:
			if astar.is_point_solid(Vector2i(i, j)):
				dist[j * size.x + i] = 0
				queue.append(j * size.x + i)
	var reach := ceili(MARGIN / cell)
	var head := 0
	while head < queue.size():
		var k := queue[head]
		head += 1
		var d := dist[k]
		if d >= reach:
			continue
		var x := k % size.x
		var y := k / size.x
		for o in [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]:
			var nx: int = x + o.x
			var ny: int = y + o.y
			if nx < 0 or ny < 0 or nx >= size.x or ny >= size.y:
				continue
			var nk := ny * size.x + nx
			if dist[nk] > d + 1:
				dist[nk] = d + 1
				queue.append(nk)
	_near.resize(n)
	_near.fill(0)
	for k in n:
		var d := dist[k]
		if d > 0 and d < reach:
			_near[k] = 1
			astar.set_point_weight_scale(Vector2i(k % size.x, k / size.x), 1.0 + 4.0 * (1.0 - float(d) / reach))


## Only cells inside this outline stay walkable (until unrestrict()).
var _saved := PackedByteArray()


func restrict(poly: PackedVector2Array) -> void:
	if _saved.is_empty():
		_saved.resize(size.x * size.y)
		for j in size.y:
			for i in size.x:
				_saved[j * size.x + i] = 1 if astar.is_point_solid(Vector2i(i, j)) else 0
	for j in size.y:
		for i in size.x:
			var c := Vector2i(i, j)
			if not astar.is_point_solid(c) and not Geometry2D.is_point_in_polygon(centre(c), poly):
				astar.set_point_solid(c, true)


## The whole floor walkable again, as before restrict().
func unrestrict() -> void:
	if _saved.is_empty():
		return
	for j in size.y:
		for i in size.x:
			astar.set_point_solid(Vector2i(i, j), _saved[j * size.x + i] == 1)
	_saved = PackedByteArray()


## Length of the walking route from a to b (INF when b cannot be reached).
func path_length(a: Vector2, b: Vector2) -> float:
	var r := path(a, b, false)
	if r.is_empty():
		return INF
	var L := a.distance_to(r[0])
	for i in range(1, r.size()):
		L += r[i - 1].distance_to(r[i])
	return L


## Map matching for a live position fix: the walkable spot near the raw fix that is most plausible given where
## the person was a moment ago. Noise must not put them through a wall into the next room: a spot that can only
## be reached by a long way round loses to one on their side of the wall, unless the fix is far from it.
func match_fix(raw: Vector2, prev: Vector2, accuracy: float, has_prev: bool) -> Vector2:
	var q := nearest_free(raw, 30)
	if not has_prev:
		return q
	# how far anyone can have walked since the last fix: to the fix, give or take its error on both ends
	var acc := clampf(accuracy, 0.3, 4.0)
	var budget := prev.distance_to(raw) + 2.0 * acc + 0.5
	var walked := path_length(prev, q)
	if walked <= minf(budget, prev.distance_to(q) * 1.35 + 0.8):
		return q
	# look around the fix for the closest spot that can be reached in that distance (their side of the wall)
	var best := Vector2.INF
	var fallback := q
	var fallback_cost := walked + 2.0 * q.distance_to(raw)
	var r := 0.15
	while r <= acc + 0.9:
		for k in 24:
			var a := TAU * k / 24.0
			var c := raw + Vector2(cos(a), sin(a)) * r
			if not is_free(c):
				continue
			var w := path_length(prev, c)
			if w <= budget and w <= prev.distance_to(c) * 1.35 + 0.8:
				if best == Vector2.INF or c.distance_to(raw) < best.distance_to(raw):
					best = c
			elif w + 2.0 * c.distance_to(raw) < fallback_cost:
				fallback_cost = w + 2.0 * c.distance_to(raw)
				fallback = c
		if best != Vector2.INF:
			return best  # the nearest ring with a plausible spot
		r += 0.15
	return fallback


func to_cell(p: Vector2) -> Vector2i:
	return Vector2i(floori((p.x - origin.x) / cell), floori((p.y - origin.y) / cell))


func centre(c: Vector2i) -> Vector2:
	return origin + (Vector2(c) + Vector2(0.5, 0.5)) * cell


func is_free(p: Vector2) -> bool:
	var c := to_cell(p)
	return _inside(c) and not astar.is_point_solid(c)


## Nearest walkable cell centre to p (searching outward up to `rings` cells), or p itself if none.
func nearest_free(p: Vector2, rings := 40) -> Vector2:
	var c0 := to_cell(p)
	if _inside(c0) and not astar.is_point_solid(c0):
		return p
	for r in range(1, rings + 1):
		var best := Vector2.INF
		for i in range(-r, r + 1):
			for j in [-r, r]:
				for c in [c0 + Vector2i(i, j), c0 + Vector2i(j, i)]:
					if _inside(c) and not astar.is_point_solid(c) and centre(c).distance_to(p) < best.distance_to(p):
						best = centre(c)
		if best != Vector2.INF:
			return best
	return p


## Walking route from a to b through doorways: it keeps clear of furniture and walls, goes through each
## doorway through its middle and square on, and is straightened only where that stays clear.
## Empty when nothing can be reached; with `partial`, the route ends at the reachable point closest to b.
func path(a: Vector2, b: Vector2, partial := true) -> PackedVector2Array:
	var ca := to_cell(nearest_free(a))
	var cb := to_cell(nearest_free(b))
	if not _inside(ca) or not _inside(cb):
		return PackedVector2Array()
	var ids := astar.get_id_path(ca, cb, partial)
	if ids.is_empty():
		return PackedVector2Array()
	var pts: Array = [a]
	var fixed: Array = [true]
	for i in ids.size():
		var c := centre(ids[i])
		if i > 0:
			var door := _door_between(centre(ids[i - 1]), c)
			if not door.is_empty():
				# through the doorway: line up in front of it, cross at the middle, step clear on the far side
				for q in door:
					pts.append(q)
					fixed.append(true)
		pts.append(c)
		fixed.append(false)
	if ids[ids.size() - 1] == cb and is_free(b):
		pts.append(b)
		fixed.append(true)
	# string pulling: from each point jump to the furthest point still in clear straight sight,
	# never skipping a doorway point
	var out := PackedVector2Array()
	var i := 0
	while i < pts.size() - 1:
		var j := i + 1
		while j + 1 < pts.size() and not fixed[j] and line_ok(pts[i], pts[j + 1]):
			j += 1
		out.append(pts[j])
		i = j
	return out


## The doorway the step from p to q goes through, as [in front, middle, beyond], or [].
func _door_between(p: Vector2, q: Vector2) -> Array:
	for g in gaps:
		var a: Vector2 = g[0]
		var b: Vector2 = g[1]
		if Geometry2D.segment_intersects_segment(p, q, a, b) == null:
			continue
		var mid := (a + b) / 2
		var u := (b - a).normalized()
		var n := Vector2(-u.y, u.x)
		var s := signf((q - p).dot(n))
		var out: Array = []
		for k in [-0.6, 0.0, 0.6]:
			var r: Vector2 = mid + n * s * k
			if is_free(r):
				out.append(r)
		return out
	return []


## A straight walk from a to b that stays clear: every point on it is walkable, and away from the two
## ends it does not brush past obstacles.
func line_ok(a: Vector2, b: Vector2) -> bool:
	var n := maxi(1, ceili(a.distance_to(b) / (cell * 0.5)))
	for k in n + 1:
		var q := a.lerp(b, float(k) / n)
		var c := to_cell(q)
		if not _inside(c) or astar.is_point_solid(c):
			return false
		if _near[c.y * size.x + c.x] == 1 and q.distance_to(a) > 0.6 and q.distance_to(b) > 0.6:
			return false
	return true


func reaches(a: Vector2, b: Vector2) -> bool:
	var ca := to_cell(nearest_free(a))
	var cb := to_cell(nearest_free(b))
	return _inside(ca) and _inside(cb) and not astar.get_id_path(ca, cb).is_empty()


func line_free(a: Vector2, b: Vector2) -> bool:
	var n := maxi(1, ceili(a.distance_to(b) / (cell * 0.5)))
	for k in n + 1:
		if not is_free(a.lerp(b, float(k) / n)):
			return false
	return true


func _inside(c: Vector2i) -> bool:
	return c.x >= 0 and c.y >= 0 and c.x < size.x and c.y < size.y


func _fill(poly: PackedVector2Array, solid: bool) -> void:
	var bb := _bbox(poly)
	var a := to_cell(bb.position)
	var b := to_cell(bb.end)
	for i in range(a.x, b.x + 1):
		for j in range(a.y, b.y + 1):
			var c := Vector2i(i, j)
			if _inside(c) and Geometry2D.is_point_in_polygon(centre(c), poly):
				if solid or Store.room_at(centre(c)).size() > 0:
					astar.set_point_solid(c, solid)


static func _bbox(poly: PackedVector2Array) -> Rect2:
	var bb := Rect2(poly[0], Vector2.ZERO)
	for v in poly:
		bb = bb.expand(v)
	return bb


## Doorways for rooms the plan gives no way into: rooms are linked through their doors; any room that
## can't be reached from the best-connected room gets a 0.9 m doorway in the longest wall it shares with a
## reachable room. Returned as door furniture ({kind: "door", x, z, w, d, rot, auto: true}).
static func auto_doors(rooms: Array, furniture: Array) -> Array:
	if rooms.is_empty():
		return []
	var polys := {}
	for r in rooms:
		polys[r.key] = PlanGeo.room_poly(r)
	var adj := {}
	for k in polys:
		adj[k] = {}
	for f in furniture:
		if f.get("kind", "") == "door":
			_link(Vector2(float(f.x), float(f.z)), polys, adj)
	var start: String = rooms[0].key
	for k in adj:
		if adj[k].size() > adj[start].size():
			start = k
	var seen := {}
	_flood(start, adj, seen)
	var added: Array = []
	var progress := true
	var guard := polys.size()
	while progress and seen.size() < polys.size() and guard > 0:
		guard -= 1
		progress = false
		var best := []
		var best_score := INF
		for k in polys:
			if seen.has(k):
				continue
			for s in seen:
				for seg in _shared(polys[k], polys[s]):
					if seg[0].distance_to(seg[1]) <= 1.1:  # must fit a 0.9 m opening plus jambs
						continue
					var spot := _clear_spot(seg[0], seg[1], furniture)
					var score: float = spot[1] - seg[0].distance_to(seg[1]) * 0.01  # clear first, then longer
					if score < best_score:
						best_score = score
						best = [seg[0], seg[1], spot[0]]
		if best.size() == 3:
			var a: Vector2 = best[0]
			var b: Vector2 = best[1]
			var u := (b - a).normalized()
			var mid: Vector2 = best[2]
			added.append({"kind": "door", "x": mid.x, "z": mid.y, "w": minf(0.9, a.distance_to(b) - 0.2), "d": 0.1,
				"rot": atan2(-u.y, u.x), "auto": true})
			_link(mid, polys, adj)
			_flood(start, adj, seen)
			progress = true
	return added


## The point along a shared wall where a doorway is least blocked by furniture on either side
## (nearest the middle among equals), and its score: [point, blocking count + a fraction for off-centre].
static func _clear_spot(a: Vector2, b: Vector2, furniture: Array) -> Array:
	var len := a.distance_to(b)
	var u := (b - a) / len
	var n := Vector2(-u.y, u.x)
	var rects: Array = []
	for f in furniture:
		if not SOFT.has(f.get("kind", "")):
			rects.append(Placer._rect(Vector2(float(f.x), float(f.z)), Vector2(float(f.w) + 0.5, float(f.d) + 0.5), float(f.get("rot", 0.0))))
	var best := (a + b) / 2
	var best_score := INF
	var t := 0.55
	while t <= len - 0.55 + 1e-4:
		var q := a + u * t
		var score := absf(t - len / 2) / maxf(len, 1.0)  # below 1: only breaks ties between clear spots
		for side in [0.0, 0.45, -0.45, 0.9, -0.9]:
			for r in rects:
				if Geometry2D.is_point_in_polygon(q + n * side, r):
					score += 1.0
		if score < best_score:
			best_score = score
			best = q
		t += 0.2
	return [best, best_score]


## A walkable spot in the room that can be reached from `from`: the room's middle if possible, else just
## inside one of its doorways, else any reachable spot in the room (nearest the middle). INF if none.
func room_target(r: Dictionary, from: Vector2) -> Vector2:
	var poly := PlanGeo.room_poly(r)
	var mid := PlanGeo.interior_point(poly)
	var cands: Array = [nearest_free(mid, 30)]
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var nn := Vector2(sin(float(f.get("rot", 0.0))), cos(float(f.get("rot", 0.0))))
		for side in [0.7, -0.7]:
			if Geometry2D.is_point_in_polygon(c + nn * side, poly):
				cands.append(nearest_free(c + nn * side, 4))
	var grid: Array = []
	var bb := _bbox(poly)
	var step := maxf(0.8, maxf(bb.size.x, bb.size.y) / 12.0)
	var x := bb.position.x + step / 2
	while x < bb.end.x:
		var z := bb.position.y + step / 2
		while z < bb.end.y:
			var q := Vector2(x, z)
			if Geometry2D.is_point_in_polygon(q, poly) and is_free(q):
				grid.append(q)
			z += step
		x += step
	grid.sort_custom(func(p1, p2): return p1.distance_to(mid) < p2.distance_to(mid))
	# stop on open floor (clear of furniture by the margin) when the room has some; else anywhere free
	var fallback := Vector2.INF
	for q in cands + grid:
		if Geometry2D.is_point_in_polygon(q, poly) and is_free(q) and reaches(from, q):
			var c := to_cell(q)
			if _near.size() == 0 or _near[c.y * size.x + c.x] == 0:
				return q
			if fallback == Vector2.INF:
				fallback = q
	return fallback


static func _link(p: Vector2, polys: Dictionary, adj: Dictionary) -> void:
	var touch: Array = []
	for k in polys:
		var poly: PackedVector2Array = polys[k]
		for i in poly.size():
			if p.distance_to(Geometry2D.get_closest_point_to_segment(p, poly[i], poly[(i + 1) % poly.size()])) < 0.3:
				touch.append(k)
				break
	for a in touch:
		for b in touch:
			if a != b:
				adj[a][b] = true


## Marks every room reachable from `start` or from a room already marked.
static func _flood(start: String, adj: Dictionary, seen: Dictionary) -> void:
	seen[start] = true
	var todo: Array = seen.keys()
	while not todo.is_empty():
		var k: String = todo.pop_back()
		for n in adj[k]:
			if not seen.has(n):
				seen[n] = true
				todo.append(n)


## Every stretch of wall two room outlines have in common, as [[a, b], ...].
static func _shared(p: PackedVector2Array, q: PackedVector2Array) -> Array:
	var out: Array = []
	for i in p.size():
		var a := p[i]
		var b := p[(i + 1) % p.size()]
		var len := a.distance_to(b)
		if len < 0.5:
			continue
		var u := (b - a) / len
		var n := Vector2(-u.y, u.x)
		for j in q.size():
			var c := q[j]
			var d := q[(j + 1) % q.size()]
			if absf((c - a).dot(n)) > 0.06 or absf((d - a).dot(n)) > 0.06:
				continue
			var t0 := clampf(minf((c - a).dot(u), (d - a).dot(u)), 0.0, len)
			var t1 := clampf(maxf((c - a).dot(u), (d - a).dot(u)), 0.0, len)
			if t1 - t0 > 0.5:
				out.append([a + u * t0, a + u * t1])
	return out
