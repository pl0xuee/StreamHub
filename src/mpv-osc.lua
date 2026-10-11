-- StreamHub's player controls, drawn by mpv itself.
--
-- mpv puts its picture in a native child window of ours, and a native child always draws above the
-- page beneath it, so nothing the app paints in HTML can reach the film. The controls therefore
-- have to be drawn *inside* mpv, and the only drawing surface a player script has is ASS subtitle
-- markup. So this is src/ui/styles.css restated in that language: the same tokens, the same
-- tinted glass for anything that floats, the same lit-steel accent.
--
-- Loaded with `--script=<this file>` alongside `--no-osc`, in place of mpv's built-in controller.
-- It replaces that controller rather than restyling it: the built-in one is a different material
-- (opaque black gradient, its own icon font, its own window buttons) and every part of it that
-- would have to change is the part that is hard-coded. Replacing it means owing everything it
-- did — chapter skip, playlist skip, the cache range shaded into the seek bar, chapter marks, the
-- hover timestamp, the elapsed/remaining toggle, track switching — so all of that is here.
--
-- The shape is a cinema's rather than a toolbar's. There is no slab across the bottom of the
-- picture any more: a film is framed by darkness, not by a panel, so the controls stand on a soft
-- fall of shadow that rises from the bottom edge, and the film's name sits top-left on a matching
-- one, the way a title card does. Glass is kept for the things that genuinely float over the
-- picture — the track pills, the menus they open, the chips above the timeline and the disc in the
-- middle while the film is paused. The timeline runs the full width above the row, steel behind
-- the playhead, and thickens under the pointer, which is when it stops being a reading and starts
-- being a control. When the window is too narrow for the row, features are dropped in a fixed
-- order (see FIT_ORDER) rather than being crushed.
--
-- The whole thing fades rather than blinking in and out, and pausing or resuming is answered in
-- the middle of the picture, where the eye already is, rather than only by a glyph changing in a
-- corner.
--
-- Two things about ASS decide most of what follows. Colours are written &HBBGGRR& — the reverse of
-- a CSS hex triple — and alpha runs the other way as well, 00 opaque to FF invisible. And there is
-- no border-radius: every rounded corner in here is a Bézier in a vector path, which is why the
-- drawing helpers come first and everything else is built out of them.

local mp = require 'mp'
local msg = require 'mp.msg'

-- ---------------------------------------------------------------------------------------------
-- Palette
--
-- Every value is a token from src/ui/styles.css with its bytes turned around. #eef1f6 is written
-- &HF6F1EE&; get that backwards and the whole bar comes out the wrong temperature. Alphas are
-- derived from the CSS opacity by A() rather than written as magic bytes, so a token that moves in
-- the stylesheet can be moved here by copying the same number across.
-- ---------------------------------------------------------------------------------------------

local INK = '&H000000&'
local WHITE = '&HFFFFFF&'
local GUN_RAISED = '&H251C18&' -- #181c25
local TEXT = '&HF6F1EE&' -- #eef1f6
local DIM = '&HD8CBC2&' -- #c2cbd8
local DIM_2 = '&HC1B1A6&' -- #a6b1c1
local STEEL = '&HC8B29D&' -- #9db2c8
local STEEL_HOT = '&HEFE2D6&' -- #d6e2ef
local EXIT = '&H524AC9&' -- #c94a52
local WINDOW_INK = '&H15100D&' -- #0d1015, --ink: the glyph on the lit play button

-- CSS opacity to an ASS alpha byte: opaque is 00 here and 1 there, so the scale is inverted.
local function A(opacity)
  return string.format('&H%02X&', math.floor((1 - opacity) * 255 + 0.5))
end

local OPAQUE = A(1)
local ALPHA_RAISED = A(0.9) -- --gun-raised
local ALPHA_EDGE = A(0.075) -- --edge
local ALPHA_EDGE_STRONG = A(0.13) -- --edge-strong
local ALPHA_STEEL_WASH = A(0.16) -- --steel-wash
local ALPHA_STEEL_EDGE = A(0.34) -- --steel-edge
local ALPHA_DISABLED = A(0.3) -- a control there is nothing for to do

-- Two faces, and ASS takes one name each — no falling down a stack the way CSS does.
--
-- --font-body led with Inter, which is not installed on any machine this has run on, so libass
-- was quietly substituting its own sans and the bar was set in a face the app never uses. Rather
-- than name a font and hope, everything here is set in the two the app ships against: the display
-- face for words, the mono for numbers. Condensed suits a strip of chrome anyway — a long film
-- title fits without shrinking the type — and numbers that change every second have to be
-- tabular or the clock jitters.
local FONT_DISPLAY = 'Fira Sans Condensed'
local FONT_MONO = 'Adwaita Mono'

-- ---------------------------------------------------------------------------------------------
-- Geometry, in CSS pixels at 1x
--
-- Every one of these is multiplied by a single scale factor before anything is drawn; see
-- scale_for(). The row is 40 units tall and held `margin` in from the bottom and sides; the
-- timeline sits on top of it with a little air between them.
-- ---------------------------------------------------------------------------------------------

local D = {
  margin = 22, -- how far everything is held in from the window's edges
  radius_lg = 14, -- the menus, which are the largest floating thing
  radius_sm = 8,
  row_h = 40,
  btn = 32, -- a round button, and the height of every hit target in the row
  play = 40, -- the button the row exists for, a size up from the rest
  icon = 15, -- the box every glyph is drawn in
  play_icon = 17,
  skip_icon = 20, -- the ±10 rings carry a numeral inside, so they need the extra room
  gap = 2, -- between neighbouring buttons
  group = 14, -- between one group of controls and the next
  rail = 4, -- what is drawn of the volume slider; the target around it is `btn` tall
  knob = 12,
  vol_w = 76,
  -- The timeline. `band` is what can be grabbed, and it is much taller than the line, because a
  -- 4-unit line is not something anyone can hit without looking.
  seam_band = 18,
  seam_rail = 4,
  seam_rail_hot = 7,
  seam_knob = 15,
  seam_gap = 6,
  pill_h = 28,
  pill_pad = 11,
  pill_gap = 7,
  spacer_min = 24, -- below this the row gives something up rather than touching end to end
  -- The two falls of shadow. Heights are where they fade to nothing; the dark is at the edge.
  scrim_h = 230,
  top_scrim_h = 170,
  fs_title = 22,
  fs_meta = 12.5,
  title_gap = 5,
  -- The paused disc in the middle of the picture.
  disc = 84,
  disc_icon = 34,
  big_spinner = 44,
  -- The track menus the pills open. A film can carry twenty-seven subtitle tracks, so the list
  -- has a height it will not grow past and scrolls inside it.
  menu_row = 30,
  menu_pad = 6,
  menu_head = 30,
  menu_min_w = 230,
  menu_max_w = 420,
  menu_gap = 14, -- between a menu's right-hand meta column and the name it belongs to
  -- The subtitle menu's timing row: the step buttons, the readout between them, and the width the
  -- menu needs to hold them all beside their label.
  timing_btn = 40,
  timing_val = 64,
  menu_timing_w = 320,
  chip_pad_x = 10, -- the hover timestamp and the track toast
  chip_h = 24,
  chip_lift = 8,
  fs_time = 12.5,
  fs_label = 10,
  fs_value = 11.5,
  fs_chip = 11.5,
  fs_skip = 6.4,
}

-- How long the bar waits before leaving. It only ever goes while something is actually playing.
local HIDE_AFTER = 2.5
local FRAME = 1 / 12
-- Fading runs on its own, faster clock, and only while something is actually moving: a twelfth
-- of a second is fine for a clock that ticks once a second and visibly steps a fade.
local ANIM_FRAME = 1 / 40
local FADE_IN = 0.16
local FADE_OUT = 0.38
-- The disc that answers a pause or a resume in the middle of the picture: how long it takes to
-- swell and go.
local FLASH_FOR = 0.55
-- How long a track change stays named above the bar.
local TOAST_FOR = 2.2
-- What the skip buttons jump by. Ten seconds is what every streaming service the app sits beside
-- uses, so it is what a hand that has just come from one of them expects.
local SKIP = 10

-- What gets given up, in order, when the row will not fit the window. The words on the pills go
-- first — the languages still say what they are — then the volume slider, whose button remains,
-- then the playlist and chapter steps, then the ten-second skips, and the clocks last, because a
-- film with no way to tell where you are in it is the one thing a narrow window should not cost.
local FIT_ORDER = { 'labels', 'volume', 'playlist', 'chapters', 'skip', 'clocks' }

-- Language codes as the pills show them. Files and Jellyfin both carry ISO 639-2 ("eng", "jpn"),
-- which is three letters where two say it as well and are what a person reads as a language.
-- Anything not here is shown as it came, so an unusual language is never hidden, only longer.
local LANG2 = {
  eng = 'EN', jpn = 'JA', spa = 'ES', fre = 'FR', fra = 'FR', ger = 'DE', deu = 'DE',
  ita = 'IT', por = 'PT', rus = 'RU', chi = 'ZH', zho = 'ZH', kor = 'KO', ara = 'AR',
  hin = 'HI', dut = 'NL', nld = 'NL', swe = 'SV', nor = 'NO', nob = 'NB', dan = 'DA',
  fin = 'FI', pol = 'PL', tur = 'TR', gre = 'EL', ell = 'EL', heb = 'HE', hun = 'HU',
  cze = 'CS', ces = 'CS', tha = 'TH', vie = 'VI', ind = 'ID', ukr = 'UK', rum = 'RO',
  ron = 'RO', may = 'MS', msa = 'MS', fil = 'FIL', tam = 'TA', tel = 'TE', ben = 'BN',
}

-- ---------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

local function fmt_time(t, signed)
  if type(t) ~= 'number' or t ~= t then t = 0 end
  local sign = ''
  if signed then sign = '-' end
  if t < 0 then t = 0 end
  local total = math.floor(t)
  local h = math.floor(total / 3600)
  local m = math.floor(total / 60) % 60
  local s = total % 60
  if h > 0 then return string.format('%s%d:%02d:%02d', sign, h, m, s) end
  return string.format('%s%d:%02d', sign, m, s)
end

-- A title arrives from the file and can contain anything. `{` opens an override block in ASS, so
-- an unescaped one silently eats the rest of the line — this is correctness, not tidiness.
local function ass_escape(s)
  s = tostring(s or '')
  s = s:gsub('\\', '\\\239\187\191') -- a zero-width no-break space keeps the backslash literal
  s = s:gsub('{', '\\{')
  s = s:gsub('}', '\\}')
  s = s:gsub('[\r\n]+', ' ')
  return s
end

-- ---------------------------------------------------------------------------------------------
-- Vector drawing
--
-- ASS drawing coordinates are integers scaled by the \p level: \p4 divides them by eight. Working
-- in eighths rather than \p1 keeps every number an integer — fractional coordinates in a drawing
-- are a libass extension rather than part of the format — while still being finer than any edge
-- here needs.
-- ---------------------------------------------------------------------------------------------

local DRAW_SCALE = 8
-- The \p level that divides by that, which \clip has to be told separately: a clip path is written
-- in the same eighths as the shape it came from, but it carries its own scale rather than
-- inheriting the one the drawing is under.
local DRAW_SCALE_TAG = 4
local function q(v)
  return string.format('%d', math.floor(v * DRAW_SCALE + 0.5))
end

-- The circular-arc constant: control points this far along the tangents put a cubic within a
-- quarter of a percent of a true quarter circle. Corners drawn with the control points *on* the
-- corner instead are visibly flat at a 16-unit radius.
local KAPPA = 0.5523

-- A rectangle with a radius per corner, clockwise from the top left. Everything with a rounded
-- edge in here — the slab, the buttons, the pills, the rails, the knob, the chips — is this.
local function rrect4(x, y, w, h, tl, tr, br, bl)
  if w <= 0 or h <= 0 then return '' end
  local lim = math.min(w, h) / 2
  tl, tr = clamp(tl, 0, lim), clamp(tr, 0, lim)
  br, bl = clamp(br, 0, lim), clamp(bl, 0, lim)
  local x1, y1 = x + w, y + h
  local p = {}
  local function put(...)
    p[#p + 1] = table.concat({ ... }, ' ')
  end
  put('m', q(x + tl), q(y))
  put('l', q(x1 - tr), q(y))
  if tr > 0 then
    put('b', q(x1 - tr + tr * KAPPA), q(y), q(x1), q(y + tr - tr * KAPPA), q(x1), q(y + tr))
  end
  put('l', q(x1), q(y1 - br))
  if br > 0 then
    put('b', q(x1), q(y1 - br + br * KAPPA), q(x1 - br + br * KAPPA), q(y1), q(x1 - br), q(y1))
  end
  put('l', q(x + bl), q(y1))
  if bl > 0 then
    put('b', q(x + bl - bl * KAPPA), q(y1), q(x), q(y1 - bl + bl * KAPPA), q(x), q(y1 - bl))
  end
  put('l', q(x), q(y + tl))
  if tl > 0 then
    put('b', q(x), q(y + tl - tl * KAPPA), q(x + tl - tl * KAPPA), q(y), q(x + tl), q(y))
  end
  return table.concat(p, ' ')
end

local function rrect(x, y, w, h, r)
  return rrect4(x, y, w, h, r, r, r, r)
end

local function rect(x, y, w, h)
  return rrect4(x, y, w, h, 0, 0, 0, 0)
end

-- A line with width, as a quad. ASS can stroke a path with \bord, but a stroke follows the whole
-- outline including the closing edge an open path gets for free, so the crossed-out speaker, the ×
-- and the fullscreen brackets are drawn as filled shapes instead.
local function stroke(x0, y0, x1, y1, w)
  local dx, dy = x1 - x0, y1 - y0
  local len = math.sqrt(dx * dx + dy * dy)
  if len == 0 then return '' end
  local nx, ny = -dy / len * w / 2, dx / len * w / 2
  return table.concat({
    'm', q(x0 + nx), q(y0 + ny),
    'l', q(x1 + nx), q(y1 + ny),
    'l', q(x1 - nx), q(y1 - ny),
    'l', q(x0 - nx), q(y0 - ny),
  }, ' ')
end

local function triangle(x0, y0, x1, y1, x2, y2)
  return table.concat({ 'm', q(x0), q(y0), 'l', q(x1), q(y1), 'l', q(x2), q(y2) }, ' ')
end

-- An arc of given thickness — the waves off the speaker, and the buffering ring. Built as an outer
-- arc out and an inner arc back, each in 45-degree Bézier steps, because a single cubic over a
-- wide angle bows. The return sweep runs the other way round, which is what makes a ring a ring
-- rather than a disc under either fill rule.
local function arc(cx, cy, radius, thick, a0, a1)
  local steps = math.max(1, math.ceil(math.abs(a1 - a0) / (math.pi / 4)))
  local out = {}
  local function sweep(r, from, to)
    local step = (to - from) / steps
    local k = 4 / 3 * math.tan(step / 4)
    for i = 0, steps - 1 do
      local t0, t1 = from + step * i, from + step * (i + 1)
      local p0x, p0y = cx + r * math.cos(t0), cy + r * math.sin(t0)
      local p1x, p1y = cx + r * math.cos(t1), cy + r * math.sin(t1)
      if i == 0 then
        out[#out + 1] = table.concat({ #out == 0 and 'm' or 'l', q(p0x), q(p0y) }, ' ')
      end
      out[#out + 1] = table.concat({
        'b',
        q(p0x - k * r * math.sin(t0)), q(p0y + k * r * math.cos(t0)),
        q(p1x + k * r * math.sin(t1)), q(p1y - k * r * math.cos(t1)),
        q(p1x), q(p1y),
      }, ' ')
    end
  end
  sweep(radius + thick / 2, a0, a1)
  sweep(radius - thick / 2, a1, a0)
  return table.concat(out, ' ')
end

-- ---------------------------------------------------------------------------------------------
-- ASS events
--
-- The overlay's data is one event per line, drawn in order, so a line added later covers one added
-- earlier. Every line resets the tags it depends on: the OSD style underneath carries a border and
-- a shadow that would otherwise fur every shape and every glyph.
-- ---------------------------------------------------------------------------------------------

local function shape(tags, path)
  if path == '' then return '' end
  return string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\blur0%s\\p4}%s{\\p0}', tags, path)
end

local function fill(colour, alpha)
  return string.format('\\1c%s\\1a%s', colour, alpha)
end

local function hairline(width, colour, alpha)
  return string.format('\\bord%.2f\\3c%s\\3a%s', width, colour, alpha)
end

local function label(x, y, an, tags, str)
  return string.format('{\\an%d\\pos(%.1f,%.1f)\\bord0\\shad0\\blur0\\q2%s}%s', an, x, y, tags, str)
end

local function colour_tags(colour, alpha)
  return string.format('\\1c%s\\1a%s', colour, alpha or OPAQUE)
end

-- ---------------------------------------------------------------------------------------------
-- Text measurement
--
-- Laying one row out needs to know how wide the clocks, the pills and the title are before any of
-- them are drawn. mpv will render an overlay without showing it and hand back the bounding box,
-- which is exact where a per-character estimate is not — and the results are cached, because the
-- same handful of strings is measured on every frame.
-- ---------------------------------------------------------------------------------------------

local ruler = nil
local measured = {}

local function text_width(str, tags, res_x, res_y)
  if str == '' then return 0 end
  local key = string.format('%d\0%s\0%s', res_x, tags, str)
  local hit = measured[key]
  if hit then return hit end
  -- Only reached if the measuring command fails: half an em per character is wrong, but it is
  -- wrong by a little rather than laying every element out at zero width.
  local width = #str * 0.5 * (tonumber(tags:match('\\fs([%d%.]+)')) or 12)
  if not ruler then
    ruler = mp.create_osd_overlay('ass-events')
  end
  if ruler then
    ruler.res_x, ruler.res_y = res_x, res_y
    ruler.hidden = true
    ruler.compute_bounds = true
    ruler.data = label(0, 0, 7, tags, str)
    local ok, bounds = pcall(function() return ruler:update() end)
    if ok and type(bounds) == 'table' and bounds.x1 and bounds.x0 then
      width = bounds.x1 - bounds.x0
    end
  end
  measured[key] = width
  return width
end

-- Give up the tail rather than the line, exactly as the title does in CSS.
local function ellipsize(str, tags, max_w, res_x, res_y)
  if max_w <= 0 then return '', 0 end
  local w = text_width(str, tags, res_x, res_y)
  if w <= max_w then return str, w end
  local cut = str
  while #cut > 0 do
    -- Step back over any UTF-8 continuation bytes, or a truncation lands mid-character.
    repeat
      cut = cut:sub(1, #cut - 1)
    until #cut == 0 or cut:byte(#cut) < 0x80 or cut:byte(#cut) >= 0xC0
    local candidate = cut .. '…'
    w = text_width(candidate, tags, res_x, res_y)
    if w <= max_w then return candidate, w end
  end
  return '', 0
end

-- Every alpha in a finished frame, scaled towards transparent by `f`.
--
-- ASS has no opacity for a whole overlay, so a fade is every \1a and \3a in the frame turned down
-- together. Done once over the finished string rather than threaded through every helper, so
-- nothing drawn can forget to take part — every shape and label here sets its alpha explicitly,
-- which is what makes this complete.
local function fade_alphas(data, f)
  if f >= 1 then return data end
  return (data:gsub('\\([13])a&H(%x%x)&', function(which, hex)
    local opacity = (255 - tonumber(hex, 16)) / 255 * f
    return string.format('\\%sa&H%02X&', which, math.floor((1 - opacity) * 255 + 0.5))
  end))
end

-- ---------------------------------------------------------------------------------------------
-- State
-- ---------------------------------------------------------------------------------------------

local overlay = nil
local shown = false -- the overlay is up, even if it is still fading in or already fading out
local vis, vis_target = 0, 0 -- how far faded in, and where it is heading
local last_anim = mp.get_time()
local anim_timer = nil
local last_input = mp.get_time()
local mouse = { x = -1, y = -1, hover = false }
local regions = {} -- hit boxes from the last frame, in draw order
local pressed = nil -- which region the button went down on
local drag = nil -- 'seek' | 'volume' while the pointer is held on a slider
local drag_pos = nil -- where a seek drag is pointing, so the bar tracks the pointer, not the file
local last_drag_seek = 0
-- Where the last seek was aimed, held on to until the file actually arrives there.
--
-- A seek is not instant — over a network it is not close to instant — and `time-pos` goes on
-- reporting the old position until it lands, then reports whatever keyframe it landed on before
-- the exact seek settles. Read straight, that makes the handle leave the pointer, snap back to
-- where the film was, and only then arrive: the "jumping around" when skipping through a film.
-- So the aimed-at position is what the bar shows until the file catches up with it.
local seek_target = nil
local seek_target_until = 0 -- ...and never for longer than this, whatever the file does
local SEEK_LATCH = 2.0 -- how long to keep showing the target before giving up on it
local SEEK_SETTLE = 0.75 -- how close the file has to get before it is "there"
local show_remaining = true -- the right-hand clock, toggled by clicking it
-- The open track menu, or nil. `kind` is mpv's own word for the stream — 'audio' or 'sub' — so it
-- can be handed straight to the track list and the aid/sid properties without translating.
local menu = nil
local toast_text, toast_until = nil, 0
local slab = nil -- the controls' own area, for deciding whether the pointer is on them
local menu_box = nil -- and an open menu's, which is glass the pointer can be on too
-- The pause/resume answer in the middle of the picture: which glyph, and when it started. It has
-- an overlay of its own, because it has to be seen whether the controls are up or not — pressing
-- space with the bar hidden is exactly when the picture should say something.
local flash = nil
local flash_overlay = nil
local file_ready = false -- no answering a pause that was only the file being opened

-- The position to draw: where the file is, unless a seek is still on its way somewhere, in which
-- case it is where that seek was aimed. The latch drops the moment the file gets near enough —
-- or when it has plainly not gone there at all and holding on would only be a lie.
local function settled_pos()
  local now_pos = mp.get_property_number('time-pos')
  if not seek_target then return now_pos or 0 end
  if not now_pos then return seek_target end
  if math.abs(now_pos - seek_target) < SEEK_SETTLE or mp.get_time() > seek_target_until then
    seek_target = nil
    return now_pos
  end
  return seek_target
end

-- mpv drags its own window when a button is held on the picture and the pointer moves more than a
-- few pixels, and while it is doing that the script stops hearing about the pointer at all — a
-- drag on the seek bar would set the position once and then freeze. So the built-in dragging is
-- switched off while the pointer is over the controls and put back exactly as it was on the way
-- out. (Embedded in StreamHub it is moot, since the window is not mpv's to move, but this script
-- has no business deciding that for a window it does not own.)
local dragging_default = nil
local dragging_suppressed = false

local function suppress_window_drag(over)
  if over == dragging_suppressed then return end
  if dragging_default == nil then
    dragging_default = mp.get_property_bool('input-builtin-dragging', true)
  end
  dragging_suppressed = over
  if over then
    mp.set_property_bool('input-builtin-dragging', false)
  else
    mp.set_property_bool('input-builtin-dragging', dragging_default)
  end
end

local function region_at(x, y)
  for i = #regions, 1, -1 do
    local r = regions[i]
    if x >= r.x and x <= r.x + r.w and y >= r.y and y <= r.y + r.h then return r end
  end
  return nil
end

-- Whether the pointer is in the window and inside `box` (a laid-out area, or nil).
local function pointer_in(box)
  return box ~= nil and mouse.hover
    and mouse.x >= box.x and mouse.x <= box.x + box.w
    and mouse.y >= box.y and mouse.y <= box.y + box.h
end

local function toast(text)
  toast_text = ass_escape(text)
  toast_until = mp.get_time() + TOAST_FOR
end

-- Opening and closing a track menu.
--
-- Two keys are taken for as long as one is open and given straight back afterwards. The wheel is
-- how a list longer than the window is read, and Escape is how every menu anywhere is dismissed —
-- but Escape is also how StreamHub leaves a film, so it is only borrowed while there is a menu to
-- dismiss. Bound the forced way: at the top of a list of twenty-seven subtitles, the wheel must
-- scroll the list rather than reach mpv's own bindings underneath it.
local MENU_KEYS = {
  esc = 'streamhub-osc-menu-esc',
  up = 'streamhub-osc-menu-up',
  down = 'streamhub-osc-menu-down',
}

local function close_menu()
  if not menu then return end
  menu = nil
  for _, name in pairs(MENU_KEYS) do mp.remove_key_binding(name) end
end

local function scroll_menu(by)
  if not menu then return end
  -- Clamped against the real list length at layout time, which is the only place that knows how
  -- tall the menu came out.
  menu.scroll = math.max(0, menu.scroll + by)
  last_input = mp.get_time()
end

local function open_menu(kind)
  if menu and menu.kind == kind then
    close_menu()
    return
  end
  close_menu()
  menu = { kind = kind, scroll = 0 }
  last_input = mp.get_time()
  mp.add_forced_key_binding('ESC', MENU_KEYS.esc, function() close_menu() end)
  mp.add_forced_key_binding('WHEEL_UP', MENU_KEYS.up, function() scroll_menu(-56) end)
  mp.add_forced_key_binding('WHEEL_DOWN', MENU_KEYS.down, function() scroll_menu(56) end)
end

-- ---------------------------------------------------------------------------------------------
-- Scale
--
-- The controls are sized from the window, not from the video and not from a fixed pixel size. A 4K
-- file in a 1280-wide window gets the same bar as a 480p one, and StreamHub's own 2560x1412 window
-- on a 2x display gets one twice the size of the 720-high reference — which is what a CSS pixel
-- does there, so the bar comes out the same physical size as the app's own chrome. Clamped at both
-- ends: a small window should still get a usable bar, and a very tall one should not get a
-- monstrous one.
-- ---------------------------------------------------------------------------------------------

local REFERENCE_H = 720

local function scale_for(h)
  return clamp(h / REFERENCE_H, 0.85, 2.4)
end

-- ---------------------------------------------------------------------------------------------
-- What is playing
-- ---------------------------------------------------------------------------------------------

local function lang_short(lang)
  if type(lang) ~= 'string' then return nil end
  local l = lang:lower():match('^(%a+)')
  if not l or l == 'und' or l == 'mul' or l == 'zxx' then return nil end
  if #l == 2 then return l:upper() end
  return LANG2[l] or l:upper()
end

-- `text` is "2/4", or "-/4" when the stream is off, which is how the built-in bar says it and so
-- what the toast says after a change. `value` is what the pill shows: the language, because "SUBS
-- EN" answers the question anyone glancing at it is asking, where "SUBS 2/4" sends them to the menu
-- to find out. A track with no language falls back to the count, and nothing selected says OFF.
local function track_state(kind)
  local list = mp.get_property_native('track-list') or {}
  local count, index, current = 0, nil, nil
  for _, t in ipairs(list) do
    if t.type == kind then
      count = count + 1
      if t.selected then
        index = count
        current = t
      end
    end
  end
  local value
  if count == 0 then
    value = '—'
  elseif not current then
    value = 'OFF'
  else
    value = lang_short(current.lang)
      or (count > 1 and string.format('%d/%d', index, count))
      or 'ON'
  end
  return {
    count = count,
    text = count == 0 and '—' or string.format('%s/%d', index and tostring(index) or '-', count),
    value = value,
    off = current == nil,
    track = current,
  }
end

-- Every track of one kind, in the order the file lists them, which is the order anyone who has
-- seen this file's tracks anywhere else will expect them in.
local function tracks_of(kind)
  local out = {}
  for _, t in ipairs(mp.get_property_native('track-list') or {}) do
    if t.type == kind then out[#out + 1] = t end
  end
  return out
end

local function track_name(t)
  if not t then return 'Off' end
  local parts = {}
  if t.lang then parts[#parts + 1] = t.lang:upper() end
  if t.title then parts[#parts + 1] = t.title end
  if #parts == 0 then parts[#parts + 1] = 'Track ' .. tostring(t.id) end
  if t.codec then parts[#parts + 1] = '(' .. t.codec .. ')' end
  return table.concat(parts, ' ')
end

-- What the demuxer already has, as a list of {from, to} in seconds. This is the shaded part of the
-- seek bar: over a network — which is the only way StreamHub ever plays anything — how much has
-- been fetched ahead is the difference between "it stalled" and "it is about to stall".
local function cached_ranges()
  local out = {}
  local state = mp.get_property_native('demuxer-cache-state')
  if type(state) == 'table' and type(state['seekable-ranges']) == 'table' then
    for _, r in ipairs(state['seekable-ranges']) do
      if type(r['start']) == 'number' and type(r['end']) == 'number' then
        out[#out + 1] = { from = r['start'], to = r['end'] }
      end
    end
  end
  if #out == 0 then
    -- Older mpv, or a demuxer that does not report ranges: everything from here to the cache head.
    local ahead = mp.get_property_number('demuxer-cache-time')
    local pos = mp.get_property_number('time-pos')
    if ahead and pos and ahead > pos then out[1] = { from = pos, to = ahead } end
  end
  return out
end

-- When the film will be over if it is left to play, in the clock on the wall. Jellyfin's own page
-- says this beside the film's name, and once the film has started it is the more useful of the two
-- clocks to anyone deciding whether there is time for another.
local function ends_at(remaining)
  local speed = mp.get_property_number('speed') or 1
  if speed <= 0 then return nil end
  local at = os.date('%I:%M %p', math.floor(os.time() + remaining / speed))
  return (at:gsub('^0', ''))
end

-- ---------------------------------------------------------------------------------------------
-- Layout
--
-- The row is built as a list of items with widths, one of which (a spacer) takes whatever is
-- left, pushing the track pills and the window controls to the far end. If what is left is too
-- little, a feature is dropped and the row is built again — so a narrow window loses the words on
-- the pills, then the volume slider, and so on down FIT_ORDER, rather than everything being
-- squeezed until nothing can be hit.
--
-- The same pass fills in the hit boxes, so what is drawn and what can be clicked cannot drift.
-- ---------------------------------------------------------------------------------------------

local function layout()
  local dim = mp.get_property_native('osd-dimensions')
  local W = (dim and dim.w) or mp.get_property_number('osd-width') or 0
  local H = (dim and dim.h) or mp.get_property_number('osd-height') or 0
  if W < 160 or H < 120 then return nil end

  local s = scale_for(H)
  local function u(v) return v * s end

  local L = { W = W, H = H, s = s }
  local m = u(D.margin)
  L.margin = m
  L.inner_x, L.inner_w = m, W - 2 * m
  L.row = { y = H - m - u(D.row_h), h = u(D.row_h) }
  L.mid = L.row.y + L.row.h / 2
  L.seam_y = L.row.y - u(D.seam_gap) - u(D.seam_band)
  -- The controls' own area: everything from just above the timeline to the bottom edge. It is
  -- what counts as "on the controls" for keeping the window from being dragged.
  local top = L.seam_y - u(D.chip_lift)
  L.bar = { x = 0, y = top, w = W, h = H - top }

  -- Everything the row needs to know about the file, gathered once.
  local duration = mp.get_property_number('duration') or 0
  local pos = drag_pos or settled_pos()
  L.duration, L.pos = duration, pos
  L.seekable = duration > 0
  L.idle = mp.get_property_bool('idle-active') == true
  -- With nothing loaded mpv is not "paused" — but a bar showing the pause glyph over an empty
  -- window claims something is playing, so idle reads as stopped.
  L.paused = mp.get_property_bool('pause') or L.idle
  L.muted = mp.get_property_bool('mute')
  L.volume = mp.get_property_number('volume') or 100
  L.full = mp.get_property_bool('fullscreen')
  L.chapters = mp.get_property_native('chapter-list') or {}
  L.playlist = mp.get_property_number('playlist-count') or 0
  L.audio = track_state('audio')
  L.sub = track_state('sub')
  L.buffering = mp.get_property_bool('paused-for-cache')
    or (mp.get_property_bool('core-idle') and not L.paused and L.seekable)

  L.title_tags = string.format('\\fn%s\\fs%.1f\\b1%s', FONT_DISPLAY, u(D.fs_title),
    colour_tags(TEXT))
  L.meta_tags = string.format('\\fn%s\\fs%.1f%s', FONT_DISPLAY, u(D.fs_meta), colour_tags(DIM))
  L.time_tags = string.format('\\fn%s\\fs%.1f%s', FONT_MONO, u(D.fs_time), colour_tags(DIM))
  L.label_tags = string.format(
    '\\fn%s\\fs%.1f\\fsp%.2f', FONT_DISPLAY, u(D.fs_label), u(D.fs_label) * 0.12
  )
  L.value_tags = string.format('\\fn%s\\fs%.1f\\b1', FONT_DISPLAY, u(D.fs_value))
  L.chip_tags = string.format('\\fn%s\\fs%.1f%s', FONT_MONO, u(D.fs_chip), colour_tags(TEXT))
  L.menu_tags = string.format('\\fn%s\\fs%.1f%s', FONT_DISPLAY, u(D.fs_chip), colour_tags(TEXT))
  L.menu_meta_tags = string.format('\\fn%s\\fs%.1f%s', FONT_MONO, u(D.fs_value) * 0.9,
    colour_tags(DIM_2))

  -- The title card, top left: the film's name, and under it which chapter this is and when it
  -- will finish. Nothing while idle — there is no film to name, and the app has the window then.
  L.title = nil
  if not L.idle then
    local title = mp.get_property('media-title')
    if title and title ~= '' then
      L.title = ellipsize(ass_escape(title), L.title_tags, W * 0.6, W, H)
    end
    local bits = {}
    local ch = mp.get_property_number('chapter')
    if ch and ch >= 0 and L.chapters[ch + 1] then
      local name = L.chapters[ch + 1].title
      if not name or name == '' then name = string.format('Chapter %d', ch + 1) end
      bits[#bits + 1] = ass_escape(name)
    end
    if L.seekable then
      local at = ends_at(math.max(0, duration - pos))
      if at then bits[#bits + 1] = 'Ends at ' .. at end
    end
    L.meta_line = #bits > 0 and table.concat(bits, '   ·   ') or nil
  end

  L.elapsed = fmt_time(pos)
  -- Total or remaining, and clicking it swaps them — the built-in bar's own behaviour, and the
  -- reason the right-hand clock is a control rather than a caption.
  L.right_time = (show_remaining and L.seekable)
    and fmt_time(duration - pos, true) or fmt_time(duration)
  local clock_w = math.max(
    text_width(L.elapsed, L.time_tags, W, H),
    text_width(L.right_time, L.time_tags, W, H),
    -- Hold the width of the longest string this file will ever show, or the row jumps a pixel
    -- every time a digit is gained or the clock is swapped.
    text_width(fmt_time(duration), L.time_tags, W, H),
    text_width(fmt_time(duration, true), L.time_tags, W, H)
  )

  local function pill_width(text, value, with_label)
    local w = u(D.pill_pad * 2) + text_width(value, L.value_tags, W, H)
    if with_label then
      w = w + text_width(text, L.label_tags, W, H) + u(D.pill_gap)
    end
    return w
  end

  -- One arrangement of the row, given which optional parts survive.
  local function build(feats)
    local items = {}
    local function put(item)
      items[#items + 1] = item
      return item
    end
    local function space(v)
      items[#items + 1] = { w = u(v) }
    end

    -- The transport first, at the end of the row nearest the corner the pointer comes from. In the
    -- order every transport has had them: out through the playlist, in through the chapters, then
    -- the short hops, with play in the middle of all of it.
    if feats.playlist then
      put({ kind = 'button', id = 'pl-prev', w = u(D.btn) })
      space(D.gap)
    end
    if feats.chapters then
      put({ kind = 'button', id = 'ch-prev', w = u(D.btn) })
      space(D.gap)
    end
    if feats.skip then
      put({ kind = 'button', id = 'skip-back', w = u(D.btn) })
      space(D.gap + 2)
    end
    put({ kind = 'button', id = 'play', w = u(D.play) })
    if feats.skip then
      space(D.gap + 2)
      put({ kind = 'button', id = 'skip-fwd', w = u(D.btn) })
    end
    if feats.chapters then
      space(D.gap)
      put({ kind = 'button', id = 'ch-next', w = u(D.btn) })
    end
    if feats.playlist then
      space(D.gap)
      put({ kind = 'button', id = 'pl-next', w = u(D.btn) })
    end

    space(D.group)
    put({ kind = 'button', id = 'mute', w = u(D.btn) })
    if feats.volume then
      space(D.gap + 2)
      put({ kind = 'volume', id = 'volume', w = u(D.vol_w) })
    end

    if feats.clocks then
      space(D.group + 4)
      -- Elapsed, a divider, then the total or what is left. No id on the first: nothing happens
      -- if it is clicked, so it must not light up under the pointer as though something would.
      put({ kind = 'clock', text = L.elapsed, w = clock_w, align = 6, lead = true })
      space(D.pill_gap)
      put({ kind = 'divider', w = u(1) })
      space(D.pill_gap)
      put({ kind = 'clock', id = 'clock', text = L.right_time, w = clock_w, align = 4 })
    end

    put({ kind = 'spacer', flex = true })

    put({ kind = 'pill', id = 'audio', text = 'AUDIO', value = L.audio.value,
          off = L.audio.off, labelled = feats.labels,
          w = pill_width('AUDIO', L.audio.value, feats.labels) })
    space(D.pill_gap)
    put({ kind = 'pill', id = 'subs', text = 'SUBS', value = L.sub.value,
          off = L.sub.off, labelled = feats.labels,
          w = pill_width('SUBS', L.sub.value, feats.labels) })
    space(D.group)

    put({ kind = 'button', id = 'fullscreen', w = u(D.btn) })
    space(D.gap)
    put({ kind = 'button', id = 'close', w = u(D.btn) })

    local fixed = 0
    for _, it in ipairs(items) do
      if not it.flex then fixed = fixed + (it.w or 0) end
    end
    return items, L.inner_w - fixed
  end

  -- Chapter and playlist steps only when there is somewhere for them to go. StreamHub hands mpv
  -- one file at a time, so the playlist pair is almost never here, and a pair of greyed-out
  -- buttons on every film is a row that looks broken.
  local feats = {
    playlist = L.playlist >= 2, chapters = #L.chapters > 0,
    skip = true, labels = true, volume = true, clocks = true,
  }
  local items, slack = build(feats)
  for _, giving_up in ipairs(FIT_ORDER) do
    if slack >= u(D.spacer_min) then break end
    feats[giving_up] = false
    items, slack = build(feats)
  end
  L.items = items

  -- Place them, every one centred on the row's midline.
  local x = L.inner_x
  regions = {}
  for _, it in ipairs(items) do
    if it.flex then it.w = math.max(0, slack) end
    it.x = x
    if it.kind == 'pill' then
      it.h = u(D.pill_h)
    elseif it.id == 'play' then
      it.h = u(D.play)
    else
      it.h = u(D.btn)
    end
    it.y = L.mid - it.h / 2
    x = x + it.w
    -- Only what can be acted on gets a hit box, so a disabled control neither lights up nor fires.
    local live = it.id ~= nil
    if (it.id == 'skip-back' or it.id == 'skip-fwd') and not L.seekable then live = false end
    it.live = live
    if live and it.w > 0 then regions[#regions + 1] = it end
  end

  -- The timeline, the full width of the row above it, so the line and the controls share their
  -- ends. Added to the regions after the row so it wins any hit it is in.
  L.seam = {
    kind = 'seam',
    id = 'seek',
    x = L.inner_x,
    y = L.seam_y,
    w = L.inner_w,
    h = u(D.seam_band),
    live = L.seekable,
  }
  if not L.idle then
    items[#items + 1] = L.seam
    if L.seam.live and L.seam.w > 0 then regions[#regions + 1] = L.seam end
  end

  -- The disc in the middle while paused. It is a button as well as a sign: the middle of the
  -- picture is where the pointer already is when someone reaches to carry on. Not while the flash
  -- that announces a pause is still swelling out of the same spot, or the two would stack.
  L.disc = nil
  if L.paused and not L.idle and file_ready and not flash then
    local d = u(D.disc)
    L.disc = { id = 'big-play', x = W / 2 - d / 2, y = H / 2 - d / 2, w = d, h = d, live = true }
    regions[#regions + 1] = L.disc
  end

  -- The open track menu, if there is one. It is laid out here rather than at draw time because
  -- its rows are things that can be clicked, and everything clickable has to be in `regions` —
  -- added after the row so that a menu standing over the bar takes the hits the bar would.
  L.menu = nil
  if menu then
    local rows = {}
    local anchor = nil
    for _, it in ipairs(items) do
      if it.id == (menu.kind == 'audio' and 'audio' or 'subs') then anchor = it end
    end
    -- Off first, because it is the one entry that is not a track and the one people go looking
    -- for. mpv spells it 'no' in aid/sid, which is what the row carries.
    rows[#rows + 1] = { value = 'no', name = 'Off', meta = '', on = false }
    local any = false
    for _, t in ipairs(tracks_of(menu.kind)) do
      -- The name a person would use on the left; what it is made of on the right. track_name()
      -- puts the codec in the name, which is right for a one-line toast and wrong here — it came
      -- out as "ENG (subrip)  subrip", the same fact twice on one row.
      local name = t.title
      if not name or name == '' then name = t.lang and t.lang:upper() or nil end
      if not name then name = 'Track ' .. tostring(t.id) end
      local bits = {}
      if t.title and t.lang then bits[#bits + 1] = t.lang:upper() end
      if t.codec then bits[#bits + 1] = t.codec end
      if t['demux-channel-count'] then bits[#bits + 1] = t['demux-channel-count'] .. 'ch' end
      if t.external then bits[#bits + 1] = 'file' end
      rows[#rows + 1] = {
        value = tostring(t.id),
        name = ass_escape(name),
        meta = ass_escape(table.concat(bits, '  ')),
        on = t.selected == true,
      }
      if t.selected then any = true end
    end
    rows[1].on = not any

    -- Wide enough for the longest name it holds, within reason; a name past that is cut rather
    -- than allowed to push the menu across the window. The extra row-height on the right is the
    -- column the check mark sits in.
    local name_tags = L.menu_tags
    local meta_tags = L.menu_meta_tags
    local widest = 0
    for _, r in ipairs(rows) do
      local w = text_width(r.name, name_tags, W, H)
      if r.meta ~= '' then w = w + u(D.menu_gap) + text_width(r.meta, meta_tags, W, H) end
      if w > widest then widest = w end
    end
    local timed = menu.kind == 'sub'
    local mw = clamp(widest + 2 * u(D.pill_pad) + 2 * u(D.menu_row),
      u(timed and D.menu_timing_w or D.menu_min_w), u(D.menu_max_w))

    local row_h = u(D.menu_row)
    local pad = u(D.menu_pad)
    local head_h = u(D.menu_head)
    -- The subtitle menu carries a timing row under the list, outside the part that scrolls: a
    -- subtitle file made for a different cut of the film is early or late by the same amount
    -- throughout, and the place to fix that is next to where the file was picked.
    local foot_h = timed and (row_h + pad) or 0
    local bottom = L.seam_y - u(D.chip_lift)
    local content = head_h + 2 * pad + #rows * row_h + foot_h
    -- Never taller than about two thirds of the window: a list that runs from the bar to the top
    -- of the screen has stopped being a menu over a film and started being a page in front of it,
    -- and twenty-seven tracks scroll perfectly well in less room than that.
    local mh = math.min(content, bottom - m, H * 0.62)
    local view_y = bottom - mh + head_h + pad
    local view_h = mh - head_h - 2 * pad - foot_h
    menu.scroll = clamp(menu.scroll, 0, math.max(0, #rows * row_h - view_h))

    -- Centred over the pill that opened it, and kept inside the row's span.
    local cx = anchor and (anchor.x + anchor.w / 2) or (L.inner_x + L.inner_w)
    local mx = clamp(cx - mw / 2, L.inner_x, L.inner_x + L.inner_w - mw)
    L.menu = {
      kind = menu.kind, x = mx, y = bottom - mh, w = mw, h = mh,
      rows = rows, row_h = row_h, pad = pad, head_h = head_h,
      view_y = view_y, view_h = view_h, scroll = menu.scroll,
      scrollable = #rows * row_h > view_h + 0.5,
    }
    if timed then
      -- Laid out right to left from the menu's edge: the larger step outermost, the readout in
      -- the middle. The readout is a button too — clicking it puts the subtitles back where the
      -- file has them.
      local ty = bottom - pad - row_h
      local bw, vw = u(D.timing_btn), u(D.timing_val)
      local x = mx + mw - pad
      local buttons = {}
      for _, b in ipairs({
        { value = '0.5', text = '+0.5', w = bw },
        { value = '0.1', text = '+0.1', w = bw },
        { value = 'reset', w = vw },
        { value = '-0.1', text = '−0.1', w = bw },
        { value = '-0.5', text = '−0.5', w = bw },
      }) do
        x = x - b.w
        b.x, b.y, b.h, b.id = x, ty, row_h, 'subdelay:' .. b.value
        buttons[#buttons + 1] = b
        regions[#regions + 1] = { id = b.id, x = b.x, y = b.y, w = b.w, h = b.h, live = true }
      end
      L.menu.timing = { y = ty, h = row_h, buttons = buttons, rule_y = ty - pad / 2 }
    end
    for i, r in ipairs(rows) do
      r.y = view_y + (i - 1) * row_h - menu.scroll
      -- Only what is inside the view can be hit, and a row half out of it is clipped to what can
      -- be seen of it rather than reaching past the edge of the menu.
      local top_y = math.max(r.y, view_y)
      local bot = math.min(r.y + row_h, view_y + view_h)
      if bot - top_y > 4 then
        regions[#regions + 1] = {
          id = 'track:' .. menu.kind .. ':' .. r.value,
          x = mx, y = top_y, w = mw, h = bot - top_y, live = true, row = r,
        }
      end
    end
  end

  slab = L.bar
  menu_box = L.menu
  return L
end

-- ---------------------------------------------------------------------------------------------
-- Glyphs
--
-- Each is drawn in a 15-unit box with its top left at (x, y). The shapes follow the app's own
-- chrome (src/ui/index.html), so the two sets of controls read as one design at two sizes.
-- ---------------------------------------------------------------------------------------------

local function glyph_play(x, y, s)
  return triangle(x + 4 * s, y + 2.6 * s, x + 4 * s, y + 12.4 * s, x + 12.4 * s, y + 7.5 * s)
end

local function glyph_pause(x, y, s)
  return rrect(x + 3.4 * s, y + 2.6 * s, 3 * s, 9.8 * s, 0.7 * s)
    .. ' ' .. rrect(x + 8.6 * s, y + 2.6 * s, 3 * s, 9.8 * s, 0.7 * s)
end

-- Chapter skip: the double chevron, no end bar. Playlist skip: one triangle against a bar, the
-- shape every transport has used for "the whole of the next thing" since tape.
local function glyph_chapter(x, y, s, dir)
  local function tri(cx)
    if dir > 0 then
      return triangle(x + cx * s, y + 3 * s, x + cx * s, y + 12 * s, x + (cx + 4.6) * s, y + 7.5 * s)
    end
    return triangle(x + cx * s, y + 3 * s, x + cx * s, y + 12 * s, x + (cx - 4.6) * s, y + 7.5 * s)
  end
  if dir > 0 then return tri(2.2) .. ' ' .. tri(7.4) end
  return tri(12.8) .. ' ' .. tri(7.6)
end

local function glyph_playlist(x, y, s, dir)
  if dir > 0 then
    return triangle(x + 2.8 * s, y + 3 * s, x + 2.8 * s, y + 12 * s, x + 9.6 * s, y + 7.5 * s)
      .. ' ' .. rect(x + 10.4 * s, y + 3 * s, 1.8 * s, 9 * s)
  end
  return triangle(x + 12.2 * s, y + 3 * s, x + 12.2 * s, y + 12 * s, x + 5.4 * s, y + 7.5 * s)
    .. ' ' .. rect(x + 2.8 * s, y + 3 * s, 1.8 * s, 9 * s)
end

-- The ten-second hops: a ring with a gap at the top and an arrowhead in it, turning back or on —
-- the shape every streaming service uses for exactly this, so it needs no learning. The numeral
-- inside is set as text by the caller; a vector "10" would be a font drawn by hand.
local function glyph_skip(x, y, s, dir)
  local cx, cy, r, t = x + 7.5 * s, y + 7.9 * s, 6 * s, 1.3 * s
  local top = -math.pi / 2
  local gap = 1.0
  if dir < 0 then
    return arc(cx, cy, r, t, top, top + 2 * math.pi - gap)
      .. ' ' .. triangle(cx - 2.9 * s, cy - r, cx + 0.6 * s, cy - r - 2.6 * s,
        cx + 0.6 * s, cy - r + 2.6 * s)
  end
  return arc(cx, cy, r, t, top + gap, top + 2 * math.pi)
    .. ' ' .. triangle(cx + 2.9 * s, cy - r, cx - 0.6 * s, cy - r - 2.6 * s,
      cx - 0.6 * s, cy - r + 2.6 * s)
end

-- The tick beside the playing track in a menu.
local function glyph_check(x, y, s)
  return stroke(x + 3.2 * s, y + 7.9 * s, x + 6.4 * s, y + 11 * s, 1.6 * s)
    .. ' ' .. stroke(x + 5.8 * s, y + 11 * s, x + 12 * s, y + 4.4 * s, 1.6 * s)
end

local function speaker_cone(x, y, s)
  return table.concat({
    'm', q(x + 2.6 * s), q(y + 5.6 * s),
    'l', q(x + 4.9 * s), q(y + 5.6 * s),
    'l', q(x + 8.1 * s), q(y + 2.6 * s),
    'l', q(x + 8.1 * s), q(y + 12.4 * s),
    'l', q(x + 4.9 * s), q(y + 9.4 * s),
    'l', q(x + 2.6 * s), q(y + 9.4 * s),
  }, ' ')
end

local function glyph_volume(x, y, s)
  local cx, cy = x + 8.1 * s, y + 7.5 * s
  return speaker_cone(x, y, s)
    .. ' ' .. arc(cx, cy, 2.5 * s, 1.1 * s, -0.85, 0.85)
    .. ' ' .. arc(cx, cy, 4.4 * s, 1.1 * s, -0.85, 0.85)
end

-- Muted is drawn rather than dimmed: a crossed-out speaker says "off", a faint one says "quiet".
local function glyph_muted(x, y, s)
  return speaker_cone(x, y, s)
    .. ' ' .. stroke(x + 10 * s, y + 5.4 * s, x + 13.6 * s, y + 9.2 * s, 1.2 * s)
    .. ' ' .. stroke(x + 13.6 * s, y + 5.4 * s, x + 10 * s, y + 9.2 * s, 1.2 * s)
end

-- One corner of the fullscreen glyph: an L whose arms run away from (cx, cy). The horizontal arm
-- starts half a stroke early so the elbow is square rather than notched, which is the whole
-- difference between this reading as a bracket and as two sticks.
local function corner(cx, cy, dx, dy, arm, w)
  return stroke(cx - dx * w / 2, cy, cx + dx * arm, cy, w)
    .. ' ' .. stroke(cx, cy, cx, cy + dy * arm, w)
end

local function glyph_fullscreen(x, y, s)
  local w, arm = 1.3 * s, 4 * s
  local x0, y0, x1, y1 = x + 2.6 * s, y + 2.6 * s, x + 12.4 * s, y + 12.4 * s
  return table.concat({
    corner(x0, y0, 1, 1, arm, w),
    corner(x1, y0, -1, 1, arm, w),
    corner(x0, y1, 1, -1, arm, w),
    corner(x1, y1, -1, -1, arm, w),
  }, ' ')
end

-- Already fullscreen: the same four brackets turned to face inwards, so the button says what it
-- will do rather than what it did. They sit well apart — closer than about five units and the two
-- inner uprights merge into a plus sign.
local function glyph_windowed(x, y, s)
  local w, arm = 1.3 * s, 3 * s
  local x0, y0, x1, y1 = x + 4.9 * s, y + 4.9 * s, x + 10.1 * s, y + 10.1 * s
  return table.concat({
    corner(x0, y0, -1, -1, arm, w),
    corner(x1, y0, 1, -1, arm, w),
    corner(x0, y1, -1, 1, arm, w),
    corner(x1, y1, 1, 1, arm, w),
  }, ' ')
end

local function glyph_close(x, y, s)
  return stroke(x + 4.2 * s, y + 4.2 * s, x + 10.8 * s, y + 10.8 * s, 1.4 * s)
    .. ' ' .. stroke(x + 10.8 * s, y + 4.2 * s, x + 4.2 * s, y + 10.8 * s, 1.4 * s)
end

-- ---------------------------------------------------------------------------------------------
-- Drawing
-- ---------------------------------------------------------------------------------------------

local function hovered(it)
  if drag then return it.id == drag end
  if not mouse.hover then return false end
  local at = region_at(mouse.x, mouse.y)
  return at ~= nil and at.id == it.id
end

-- A round button: the hover wash, then the glyph centred in it. Round rather than the rounded
-- square the old slab used — standing loose on shadow instead of set into a panel, a square wash
-- reads as a tile that has come unstuck, where a circle reads as light under the fingertip.
local function icon_button(out, it, s, glyph, opts)
  local on = it.live and hovered(it)
  local d = math.min(it.w, it.h)
  local bx, by = it.x + (it.w - d) / 2, it.y + (it.h - d) / 2
  if on then
    out[#out + 1] = shape(
      fill(opts.wash or STEEL, opts.wash_alpha or ALPHA_STEEL_WASH),
      rrect(bx, by, d, d, d / 2)
    )
  end
  local box = (opts.box or D.icon) * s
  local k = s * (opts.box or D.icon) / D.icon
  local ox, oy = it.x + (it.w - box) / 2, it.y + (it.h - box) / 2
  local colour, alpha = opts.colour or TEXT, OPAQUE
  if not it.live then
    colour, alpha = DIM_2, ALPHA_DISABLED
  elseif on then
    colour = opts.hot or STEEL_HOT
  end
  out[#out + 1] = shape(fill(colour, alpha), glyph(ox, oy, k))
  return on, colour, alpha, ox, oy, k
end

-- The volume slider. Steel at rest as well as in use now: standing on shadow rather than glass,
-- a grey fill was too close to the empty rail to read as a level at all. It brightens and takes a
-- handle under the pointer, which is when it is a control rather than a reading.
local function draw_volume(out, it, s, frac, on)
  local rail_h = D.rail * s
  local ry = it.y + (it.h - rail_h) / 2
  local radius = rail_h / 2
  out[#out + 1] = shape(fill(WHITE, A(0.2)), rrect(it.x, ry, it.w, rail_h, radius))
  local filled = clamp(frac, 0, 1) * it.w
  if filled > 0 then
    out[#out + 1] = shape(
      fill(on and STEEL_HOT or STEEL, OPAQUE),
      rrect(it.x, ry, filled, rail_h, radius)
    )
  end
  if on then
    local k = D.knob * s
    out[#out + 1] = shape(
      fill(STEEL, A(0.5)) .. string.format('\\blur%.1f', 4 * s),
      rrect(it.x + filled - k / 2 - s, ry + rail_h / 2 - k / 2 - s, k + 2 * s, k + 2 * s, k / 2 + s)
    )
    out[#out + 1] = shape(
      fill(WHITE, OPAQUE),
      rrect(it.x + filled - k / 2, ry + rail_h / 2 - k / 2, k, k, k / 2)
    )
  end
end

-- A floating sheet of glass: a blurred shadow under it — ASS has no box-shadow — then the tint
-- with its hairline edge, then one whisper of light across the top, clipped to the sheet so the
-- corners stay a single rounded rectangle. The same material as a menu in the app, and used for
-- everything here that stands in front of the picture.
local function glass(out, x, y, w, h, r, s, opacity)
  opacity = opacity or 0.9
  out[#out + 1] = shape(
    fill(INK, A(0.45)) .. string.format('\\blur%.1f', 12 * s),
    rrect(x, y + 6 * s, w, h, r)
  )
  out[#out + 1] = shape(
    fill(GUN_RAISED, A(opacity)) .. hairline(1, WHITE, ALPHA_EDGE_STRONG),
    rrect(x, y, w, h, r)
  )
  local soft = 9 * s
  out[#out + 1] = shape(
    fill(WHITE, A(0.05))
      .. string.format('\\blur%.1f\\clip(%d, %s)', soft, DRAW_SCALE_TAG, rrect(x, y, w, h, r)),
    rect(x - soft * 2, y - h, w + soft * 4, h + 12 * s)
  )
end

-- The track menu.
--
-- Same material as a menu in the app: dense glass, because something standing in front of the
-- picture has to read as being in front of it. The pills used to cycle, which meant reaching a
-- subtitle track twenty-six along by pressing a button twenty-six times and reading the count each
-- time. This is the list.
--
-- Rows are clipped to the space between the heading and the bottom edge, so a film with more
-- tracks than the window is tall scrolls inside the menu rather than running off the screen.
local function draw_menu(out, L, hovered_id)
  local m = L.menu
  if not m then return end
  local s = L.s
  local r = D.radius_lg * s
  local rr = D.radius_sm * s
  glass(out, m.x, m.y, m.w, m.h, r, s, 0.92)
  local head_y = m.y + m.pad + m.head_h / 2
  out[#out + 1] = label(
    m.x + D.pill_pad * s + m.pad, head_y, 4,
    L.label_tags .. colour_tags(DIM_2), m.kind == 'audio' and 'AUDIO' or 'SUBTITLES'
  )
  -- How many there are, opposite the heading: a list that scrolls should say how long it is.
  out[#out + 1] = label(
    m.x + m.w - D.pill_pad * s - m.pad, head_y, 6,
    L.menu_meta_tags, tostring(#m.rows - 1)
  )
  out[#out + 1] = shape(
    fill(WHITE, ALPHA_EDGE),
    rect(m.x + m.pad, m.view_y - m.pad / 2 - 0.5 * s, m.w - 2 * m.pad, s)
  )

  local clip = string.format(
    '\\clip(%d, %s)', DRAW_SCALE_TAG, rect(m.x, m.view_y, m.w, m.view_h)
  )
  local check_box = D.icon * s
  for _, row in ipairs(m.rows) do
    if row.y + m.row_h > m.view_y - m.row_h and row.y < m.view_y + m.view_h + m.row_h then
      local on = hovered_id == 'track:' .. m.kind .. ':' .. row.value
      -- The playing track sits in a lit row with a tick, because a list where the current entry
      -- is only a slightly brighter grey is a list you have to read twice.
      if row.on then
        out[#out + 1] = shape(
          fill(STEEL, A(on and 0.24 or 0.16)) .. hairline(1, STEEL, A(0.22)) .. clip,
          rrect(m.x + m.pad, row.y + s, m.w - 2 * m.pad, m.row_h - 2 * s, rr)
        )
      elseif on then
        out[#out + 1] = shape(
          fill(WHITE, A(0.07)) .. clip,
          rrect(m.x + m.pad, row.y + s, m.w - 2 * m.pad, m.row_h - 2 * s, rr)
        )
      end
      local name_x = m.x + m.pad + D.pill_pad * s
      local colour = row.on and STEEL_HOT or (on and WHITE or TEXT)
      out[#out + 1] = label(
        name_x, row.y + m.row_h / 2, 4,
        L.menu_tags .. colour_tags(colour) .. clip, row.name
      )
      local right = m.x + m.w - m.pad - D.pill_pad * s
      if row.on then
        out[#out + 1] = shape(
          fill(STEEL_HOT, OPAQUE) .. clip,
          glyph_check(right - check_box, row.y + m.row_h / 2 - check_box / 2, s)
        )
      end
      if row.meta ~= '' then
        out[#out + 1] = label(
          right - check_box - 6 * s, row.y + m.row_h / 2, 6,
          L.menu_meta_tags .. clip, row.meta
        )
      end
    end
  end

  -- The timing row, below a hairline that keeps it apart from the list it is not part of.
  if m.timing then
    local t = m.timing
    out[#out + 1] = shape(
      fill(WHITE, ALPHA_EDGE),
      rect(m.x + m.pad, t.rule_y - 0.5 * s, m.w - 2 * m.pad, s)
    )
    out[#out + 1] = label(
      m.x + m.pad + D.pill_pad * s, t.y + t.h / 2, 4,
      L.label_tags .. colour_tags(DIM_2), 'TIMING'
    )
    local delay = mp.get_property_number('sub-delay') or 0
    local shifted = math.abs(delay) >= 0.05
    for _, b in ipairs(t.buttons) do
      local on = hovered_id == b.id
      if on then
        out[#out + 1] = shape(
          fill(WHITE, A(0.07)),
          rrect(b.x + s, b.y + s, b.w - 2 * s, b.h - 2 * s, rr)
        )
      end
      local text, colour
      if b.value == 'reset' then
        -- Lit when the subtitles have been moved, so it is plain at a glance that they are not
        -- where the file puts them — and that this is the thing to click to put them back.
        text = shifted and string.format('%+.1f s', delay) or '0.0 s'
        colour = shifted and STEEL_HOT or DIM
        if shifted and not on then
          out[#out + 1] = shape(
            fill(STEEL, A(0.16)) .. hairline(1, STEEL, A(0.22)),
            rrect(b.x + s, b.y + s, b.w - 2 * s, b.h - 2 * s, rr)
          )
        end
      else
        text = b.text
        colour = on and WHITE or TEXT
      end
      out[#out + 1] = label(
        b.x + b.w / 2, b.y + b.h / 2, 5,
        L.menu_meta_tags .. colour_tags(colour), text
      )
    end
  end

  -- How far down a long list you are. Only when there is more list than menu.
  if m.scrollable then
    local track_h = m.view_h
    local total = #m.rows * m.row_h
    local thumb = math.max(20 * s, track_h * (track_h / total))
    local at = m.scroll / (total - track_h)
    local tx = m.x + m.w - 3 * s
    out[#out + 1] = shape(
      fill(WHITE, ALPHA_EDGE),
      rrect(tx - s, m.view_y, 2 * s, track_h, s)
    )
    out[#out + 1] = shape(
      fill(DIM_2, OPAQUE),
      rrect(tx - s, m.view_y + at * (track_h - thumb), 2 * s, thumb, s)
    )
  end
end

-- A small slab of glass above the timeline: the hover timestamp and the track toast.
local function chip(out, L, cx, text, tags)
  local s = L.s
  local w = text_width(text, tags, L.W, L.H) + 2 * D.chip_pad_x * s
  local h = D.chip_h * s
  local x = clamp(cx - w / 2, L.inner_x, L.inner_x + L.inner_w - w)
  local y = L.seam_y - D.chip_lift * s - h
  glass(out, x, y, w, h, D.radius_sm * s, s, 0.92)
  out[#out + 1] = label(x + w / 2, y + h / 2, 5, tags, text)
end

-- A fall of shadow from one edge of the window. A gradient, which ASS does not have, so it is a
-- block of ink whose inner edge is blurred: what lies inside the window is that soft edge, dark
-- at the frame and gone by `h`. The block runs past the window on its other three sides so only
-- the one edge shows. (Stacked bands of rising opacity were the other way to do it, and banded.)
local function scrim(out, L, from_top, h, opacity)
  local W, H = L.W, L.H
  local soft = h * 0.34
  local pad = soft * 3
  local edge = h * 0.52 -- where the block's blurred edge is centred, measured in from the frame
  local y = from_top and (-pad - H) or (H - edge)
  local hh = from_top and (pad + H + edge) or (edge + pad)
  out[#out + 1] = shape(
    fill(INK, A(opacity)) .. string.format('\\blur%.1f', soft),
    rect(-pad, y, W + 2 * pad, hh)
  )
end

-- The disc in the middle of the picture: glass, a soft shadow, and the glyph. `f` fades the
-- whole thing, for the flash that swells out of it.
local function disc(out, cx, cy, d, s, f, glyph)
  out[#out + 1] = shape(
    fill(INK, A(0.4 * f)) .. string.format('\\blur%.1f', 16 * s),
    rrect(cx - d / 2, cy - d / 2 + 5 * s, d, d, d / 2)
  )
  out[#out + 1] = shape(
    fill(GUN_RAISED, A(0.62 * f)) .. hairline(1.2 * s, WHITE, A(0.16 * f)),
    rrect(cx - d / 2, cy - d / 2, d, d, d / 2)
  )
  local k = d / D.disc * D.disc_icon / D.icon
  local box = D.icon * k
  out[#out + 1] = shape(fill(TEXT, A(f)), glyph(cx - box / 2, cy - box / 2, k))
end

-- The timeline.
--
-- At rest a 4-unit line: unlit ahead of the playhead and lit steel behind it, with a soft throw of
-- light under the lit part. Under the pointer it thickens, takes a handle, and shows how far the
-- pointer is from the playhead as a paler run along the line. Chapter marks are cut into it
-- always — knowing a film has chapters is worth seeing before reaching for them.
local function draw_seam(out, L, it)
  local s = L.s
  local hot = it.live and (hovered(it) or drag == 'seek')
  local th = (hot and D.seam_rail_hot or D.seam_rail) * s
  local ry = it.y + it.h / 2 - th / 2
  local r = th / 2
  local frac = it.live and clamp(L.pos / L.duration, 0, 1) or 0

  -- Ahead of the playhead: a pale groove. It stands on shadow now rather than glass, so white
  -- at a fifth is enough to be found and still plainly not the lit part.
  out[#out + 1] = shape(fill(WHITE, A(0.2)), rrect(it.x, ry, it.w, th, r))
  if not it.live then return end

  -- What the demuxer has already fetched. Over a network this is the difference between "it
  -- stalled" and "it is about to".
  for _, range in ipairs(cached_ranges()) do
    local x0 = it.x + clamp(range.from / L.duration, 0, 1) * it.w
    local x1 = it.x + clamp(range.to / L.duration, 0, 1) * it.w
    if x1 - x0 > 0.5 then
      out[#out + 1] = shape(fill(WHITE, A(0.16)), rrect(x0, ry, x1 - x0, th, r))
    end
  end

  local filled = frac * it.w
  -- Where the pointer is aiming, ahead of the playhead: a paler run up to it, so the line says
  -- how far a click would go before the click.
  if hot and not drag then
    local mx = clamp(mouse.x, it.x, it.x + it.w)
    if mx > it.x + filled then
      out[#out + 1] = shape(fill(WHITE, A(0.28)), rrect(it.x, ry, mx - it.x, th, r))
    end
  end
  if filled > 0 then
    -- --steel-glow, which ASS has no gradient for: a blurred copy of the lit part sitting under
    -- it. This is what makes the line read as lit rather than merely coloured.
    out[#out + 1] = shape(
      fill(STEEL, A(hot and 0.6 or 0.4)) .. string.format('\\blur%.1f', 5 * s),
      rrect(it.x, ry - s, filled, th + 2 * s, r)
    )
    out[#out + 1] = shape(fill(hot and STEEL_HOT or STEEL, OPAQUE), rrect(it.x, ry, filled, th, r))
  end

  -- Chapter marks: notches of shadow cut across the line, legible over both halves of it.
  for _, ch in ipairs(L.chapters) do
    if type(ch.time) == 'number' and ch.time > 0 and ch.time < L.duration then
      local cx = it.x + (ch.time / L.duration) * it.w
      out[#out + 1] = shape(fill(INK, A(0.75)), rect(cx - 1 * s, ry - 0.5, 2 * s, th + 1))
    end
  end

  if hot then
    local k = D.seam_knob * s
    local kx, ky = it.x + filled - k / 2, ry + th / 2 - k / 2
    out[#out + 1] = shape(
      fill(STEEL, A(0.6)) .. string.format('\\blur%.1f', 5 * s),
      rrect(kx - 2 * s, ky - 2 * s, k + 4 * s, k + 4 * s, k / 2 + 2 * s)
    )
    out[#out + 1] = shape(fill(WHITE, OPAQUE), rrect(kx, ky, k, k, k / 2))
  end
end

local function draw(L)
  local out = {}
  local s = L.s

  -- The two falls of shadow: always the bottom, where the controls are, and the top only when
  -- there is a title card to stand on it.
  if not L.idle then scrim(out, L, false, D.scrim_h * s, 0.82) end
  if L.title then
    scrim(out, L, true, D.top_scrim_h * s, 0.8)
    local tx, ty = L.margin, L.margin
    out[#out + 1] = label(tx, ty, 7, L.title_tags, L.title)
    if L.meta_line then
      out[#out + 1] = label(
        tx, ty + D.fs_title * s * 1.25 + D.title_gap * s, 7, L.meta_tags, L.meta_line
      )
    end
  end

  -- The middle of the picture: the paused disc, or the turning ring while the film is waiting on
  -- the network — the one thing that says the picture is still coming.
  if L.disc then
    local on = hovered(L.disc)
    disc(out, L.W / 2, L.H / 2, L.disc.w * (on and 1.06 or 1), s, 1, glyph_play)
  elseif L.buffering and not L.idle then
    local cx, cy = L.W / 2, L.H / 2
    local r, t = D.big_spinner * s / 2, 3 * s
    local a = (mp.get_time() * 4.2) % (2 * math.pi)
    out[#out + 1] = shape(fill(WHITE, A(0.14)), arc(cx, cy, r, t, 0, 2 * math.pi))
    out[#out + 1] = shape(fill(STEEL_HOT, OPAQUE), arc(cx, cy, r, t, a, a + math.pi * 0.6))
  end

  for _, it in ipairs(L.items) do
    if it.kind == 'clock' then
      local on = it.live and hovered(it)
      local colour = it.lead and TEXT or (on and STEEL_HOT or DIM)
      out[#out + 1] = label(
        it.align == 6 and it.x + it.w or it.x, L.mid, it.align,
        string.format('\\fn%s\\fs%.1f%s', FONT_MONO, s * D.fs_time, colour_tags(colour)),
        it.text
      )
    elseif it.kind == 'seam' then
      draw_seam(out, L, it)
    elseif it.kind == 'divider' then
      -- Between the two clocks: a hairline the height of a digit, which says they are two
      -- readings of one thing without spending a character on a slash.
      local h = D.fs_time * s
      out[#out + 1] = shape(fill(WHITE, A(0.3)), rect(it.x, L.mid - h / 2, it.w, h))
    elseif it.kind == 'volume' then
      draw_volume(out, it, s, L.volume / 100, hovered(it) or drag == 'volume')
    elseif it.kind == 'pill' then
      -- Glass capsules, the one thing in the row with a surface at rest: they are the only
      -- controls whose state is words, and words need something to stand on over a bright frame.
      -- Lit in steel under the pointer, and while the menu they opened is up, because a button
      -- holding a menu open is lit.
      local open = L.menu ~= nil
        and L.menu.kind == (it.id == 'audio' and 'audio' or 'sub')
      local on = hovered(it) or open
      local r = it.h / 2
      if on then
        out[#out + 1] = shape(
          fill(STEEL, A(0.22)) .. hairline(1, STEEL, ALPHA_STEEL_EDGE),
          rrect(it.x, it.y, it.w, it.h, r)
        )
      else
        out[#out + 1] = shape(
          fill(GUN_RAISED, A(0.55)) .. hairline(1, WHITE, ALPHA_EDGE_STRONG),
          rrect(it.x, it.y, it.w, it.h, r)
        )
      end
      -- The language is the reading; the word is the caption on it. OFF is dimmed, so the pill
      -- for a film with subtitles switched off does not shout that fact.
      local value_colour = on and STEEL_HOT or (it.off and DIM_2 or TEXT)
      if it.labelled then
        out[#out + 1] = label(
          it.x + D.pill_pad * s, L.mid, 4,
          L.label_tags .. colour_tags(on and STEEL or DIM_2), it.text
        )
        out[#out + 1] = label(
          it.x + it.w - D.pill_pad * s, L.mid, 6,
          L.value_tags .. colour_tags(value_colour), it.value
        )
      else
        out[#out + 1] = label(
          it.x + it.w / 2, L.mid, 5,
          L.value_tags .. colour_tags(value_colour), it.value
        )
      end
    elseif it.kind == 'button' then
      if it.id == 'play' then
        -- The one control on the row that is always lit: a solid disc of steel with the glyph cut
        -- out of it in the window's ink. Everything else here is a glyph standing on shadow; this
        -- is the button the bar exists for, and a strip of identical glyphs gives the eye nowhere
        -- to land. It brightens and throws light under the pointer.
        local on = hovered(it)
        local d = it.h
        if on then
          out[#out + 1] = shape(
            fill(STEEL, A(0.55)) .. string.format('\\blur%.1f', 7 * s),
            rrect(it.x - s, it.y - s, d + 2 * s, d + 2 * s, d / 2 + s)
          )
        end
        out[#out + 1] = shape(
          fill(on and WHITE or STEEL_HOT, OPAQUE),
          rrect(it.x, it.y, d, d, d / 2)
        )
        local k = s * D.play_icon / D.icon
        local box = D.icon * k
        out[#out + 1] = shape(
          fill(WINDOW_INK, OPAQUE),
          (L.paused and glyph_play or glyph_pause)(it.x + (d - box) / 2, it.y + (d - box) / 2, k)
        )
      elseif it.id == 'skip-back' or it.id == 'skip-fwd' then
        local dir = it.id == 'skip-back' and -1 or 1
        local _, colour, alpha, ox, oy, k = icon_button(out, it, s,
          function(x, y, kk) return glyph_skip(x, y, kk, dir) end, { box = D.skip_icon })
        out[#out + 1] = label(
          ox + 7.5 * k, oy + 8.1 * k, 5,
          string.format('\\fn%s\\fs%.1f\\b1\\1c%s\\1a%s', FONT_DISPLAY, D.fs_skip * k, colour,
            alpha),
          tostring(SKIP)
        )
      elseif it.id == 'ch-prev' then
        icon_button(out, it, s, function(x, y, k) return glyph_chapter(x, y, k, -1) end, {})
      elseif it.id == 'ch-next' then
        icon_button(out, it, s, function(x, y, k) return glyph_chapter(x, y, k, 1) end, {})
      elseif it.id == 'pl-prev' then
        icon_button(out, it, s, function(x, y, k) return glyph_playlist(x, y, k, -1) end, {})
      elseif it.id == 'pl-next' then
        icon_button(out, it, s, function(x, y, k) return glyph_playlist(x, y, k, 1) end, {})
      elseif it.id == 'mute' then
        icon_button(out, it, s, L.muted and glyph_muted or glyph_volume,
          { colour = L.muted and DIM_2 or TEXT })
      elseif it.id == 'fullscreen' then
        icon_button(out, it, s, L.full and glyph_windowed or glyph_fullscreen,
          { colour = L.full and STEEL or TEXT })
      elseif it.id == 'close' then
        -- Leaving is the destructive act here, so this is the one control allowed the exit red,
        -- and only once it is aimed at — the exit sign is never just sitting there lit.
        icon_button(out, it, s, glyph_close,
          { wash = EXIT, wash_alpha = ALPHA_RAISED, hot = WHITE })
      end
    end
  end

  -- Above the timeline: where the pointer is aiming on it, and what the last track change turned
  -- out to be.
  local seam = L.seam
  if not L.idle and seam.live and (hovered(seam) or drag == 'seek') and seam.w > 0 then
    local frac = clamp((mouse.x - seam.x) / seam.w, 0, 1)
    local at = frac * L.duration
    local text = fmt_time(at)
    -- Which chapter that is, when the file has any. A timestamp says where; the chapter name
    -- says what, and the built-in bar puts the same thing in its title line.
    local name = nil
    for _, ch in ipairs(L.chapters) do
      if type(ch.time) == 'number' and ch.time <= at then name = ch.title end
    end
    if name and name ~= '' then text = text .. '  ' .. ass_escape(name) end
    chip(out, L, seam.x + frac * seam.w, text, L.chip_tags)
  elseif toast_text and mp.get_time() < toast_until then
    chip(out, L, L.inner_x + L.inner_w * 0.5, toast_text,
      string.format('\\fn%s\\fs%.1f%s', FONT_DISPLAY, L.s * D.fs_chip, colour_tags(TEXT)))
  end

  -- Last, and so over everything: a menu stands in front of the bar it was opened from.
  local at = mouse.hover and region_at(mouse.x, mouse.y) or nil
  draw_menu(out, L, at and at.id or nil)

  return table.concat(out, '\n')
end

-- ---------------------------------------------------------------------------------------------
-- Show, hide, render
-- ---------------------------------------------------------------------------------------------

local function should_stay()
  -- Paused, buffering, idle or still loading, the bar is not in the way of anything, and going
  -- then would hide the one control that would start it again.
  if drag then return true end
  -- A menu waits to be read. Nothing about it is in the way of the film that the bar under it is
  -- not already in the way of, and having it vanish mid-list would be its own kind of rude.
  if menu then return true end
  -- A pointer resting on the controls is a hand about to use them. Hiding the bar from under it
  -- leaves the hand over controls it can no longer see.
  if pointer_in(slab) or pointer_in(menu_box) then return true end
  if mp.get_property_bool('pause') then return true end
  if mp.get_property_bool('idle-active') then return true end
  if mp.get_property_bool('paused-for-cache') then return true end
  -- Still opening. Not "no duration": a stream with no known length has none for as long as it
  -- plays, and the bar would never leave it.
  if not file_ready then return true end
  if toast_text and mp.get_time() < toast_until then return true end
  return false
end

-- Deceleration in, acceleration out — the curve CSS calls ease-out, applied to the fade so it
-- arrives softly rather than at a constant rate.
local function ease(t)
  return 1 - (1 - t) * (1 - t)
end

local function render()
  if not shown then return end
  local L = layout()
  if not L then
    if overlay then overlay:remove() end
    return
  end
  if not overlay then
    overlay = mp.create_osd_overlay('ass-events')
  end
  overlay.res_x, overlay.res_y = L.W, L.H
  overlay.hidden = false
  overlay.compute_bounds = false
  overlay.data = fade_alphas(draw(L), ease(vis))
  overlay:update()
end

-- The pause/resume flash: the disc in the middle swelling a little and fading away, with the
-- glyph of what just happened in it. Its own overlay, drawn whether the controls are up or not.
local function render_flash()
  if not flash then
    if flash_overlay then flash_overlay:remove() end
    return
  end
  local t = (mp.get_time() - flash.t0) / FLASH_FOR
  local dim = mp.get_property_native('osd-dimensions')
  local W, H = dim and dim.w or 0, dim and dim.h or 0
  if t >= 1 or W < 160 or H < 120 then
    flash = nil
    if flash_overlay then flash_overlay:remove() end
    return
  end
  if not flash_overlay then flash_overlay = mp.create_osd_overlay('ass-events') end
  local s = scale_for(H)
  local out = {}
  local grow = 1 + 0.32 * ease(t)
  disc(out, W / 2, H / 2, D.disc * s * grow, s * grow, (1 - t) * (1 - t) * 0.95,
    flash.glyph == 'pause' and glyph_pause or glyph_play)
  flash_overlay.res_x, flash_overlay.res_y = W, H
  flash_overlay.compute_bounds = false
  flash_overlay.data = table.concat(out, '\n')
  flash_overlay:update()
end

-- Every entry point from mpv goes through this. An uncaught error in a script binding stops the
-- script dead and takes the whole OSC with it, silently — the user is left with a film and no
-- controls at all, which is far worse than one frame drawn wrong.
local function guard(fn)
  return function(...)
    local ok, err = pcall(fn, ...)
    if not ok then
      msg.error(tostring(err))
    end
  end
end

-- The animation clock. Runs only while a fade or a flash is actually moving, and stops itself
-- once both have arrived, so a film playing with the bar hidden costs nothing here.
local anim_step = guard(function()
  local now = mp.get_time()
  local dt = math.min(now - last_anim, 0.1)
  last_anim = now
  if vis < vis_target then
    vis = math.min(vis_target, vis + dt / FADE_IN)
  elseif vis > vis_target then
    vis = math.max(vis_target, vis - dt / FADE_OUT)
  end
  if shown and vis <= 0 and vis_target <= 0 then
    -- Faded all the way out: now the overlay can go, and the window's dragging can come back.
    if overlay then overlay:remove() end
    shown = false
    suppress_window_drag(false)
  else
    render()
  end
  render_flash()
  if vis == vis_target and not flash and anim_timer then
    anim_timer:kill()
  end
end)

local function animate()
  last_anim = mp.get_time()
  if not anim_timer then
    anim_timer = mp.add_periodic_timer(ANIM_FRAME, anim_step)
  elseif not anim_timer:is_enabled() then
    anim_timer:resume()
  end
end

local function hide()
  if not shown then return end
  if vis_target ~= 0 then
    vis_target = 0
    animate()
  end
end

local function wake()
  last_input = mp.get_time()
  shown = true
  if vis_target ~= 1 or vis < 1 then
    vis_target = 1
    animate()
  end
  render()
end

local tick = guard(function()
  if shown and vis_target > 0 and not should_stay() and mp.get_time() - last_input > HIDE_AFTER then
    hide()
    return
  end
  render()
end)

-- ---------------------------------------------------------------------------------------------
-- Input
-- ---------------------------------------------------------------------------------------------

local function item_by_id(L, id)
  for _, it in ipairs(L.items) do
    if it.id == id then return it end
  end
  return nil
end

local function apply_seek(L, x, exact)
  local it = item_by_id(L, 'seek')
  if not it or not L.seekable or it.w <= 0 then return end
  local frac = clamp((x - it.x) / it.w, 0, 1)
  drag_pos = frac * L.duration
  local now = mp.get_time()
  -- Keyframes while the pointer is moving and one exact seek when it stops: an exact seek per
  -- pointer sample would leave the picture a second behind the handle.
  if exact then
    mp.commandv('seek', drag_pos, 'absolute+exact')
  elseif now - last_drag_seek > 0.12 then
    last_drag_seek = now
    mp.commandv('seek', drag_pos, 'absolute+keyframes')
  end
end

local function apply_volume(L, x)
  local it = item_by_id(L, 'volume')
  if not it or it.w <= 0 then return end
  mp.set_property_number('volume', math.floor(clamp((x - it.x) / it.w, 0, 1) * 100 + 0.5))
end

-- A ten-second hop, latched like a drag so the playhead goes straight to where it is going rather
-- than waiting on the file. Pressed twice quickly, the second hop counts from where the first was
-- aimed, not from where the file had got to — which is what pressing it twice means.
local function skip(by)
  local duration = mp.get_property_number('duration') or 0
  if duration <= 0 then return end
  local from = seek_target or mp.get_property_number('time-pos') or 0
  local to = clamp(from + by, 0, duration)
  seek_target = to
  seek_target_until = mp.get_time() + SEEK_LATCH
  mp.commandv('seek', to, 'absolute+exact')
end

local function activate(id)
  if id == 'play' or id == 'big-play' then
    mp.commandv('cycle', 'pause')
  elseif id == 'skip-back' then
    skip(-SKIP)
  elseif id == 'skip-fwd' then
    skip(SKIP)
  elseif id == 'mute' then
    mp.commandv('cycle', 'mute')
  elseif id == 'ch-prev' then
    mp.commandv('add', 'chapter', -1)
  elseif id == 'ch-next' then
    mp.commandv('add', 'chapter', 1)
  elseif id == 'pl-prev' then
    mp.commandv('playlist-prev', 'weak')
  elseif id == 'pl-next' then
    mp.commandv('playlist-next', 'weak')
  elseif id == 'clock' then
    show_remaining = not show_remaining
  elseif id == 'audio' or id == 'subs' then
    -- These used to cycle, which is what mpv's own controller does and is fine for a file with
    -- two audio tracks. A film with twenty-seven subtitle tracks turns it into pressing a button
    -- twenty-seven times and reading a counter after each press to find out where you are. So the
    -- pill opens the list instead, and the tracks are things you pick rather than pass through.
    open_menu(id == 'audio' and 'audio' or 'sub')
  elseif id:sub(1, 6) == 'track:' then
    local kind, value = id:match('^track:(%a+):(.+)$')
    if kind then
      mp.set_property(kind == 'audio' and 'aid' or 'sid', value)
      close_menu()
      -- Said out loud as well as shown, because the menu it was picked in is gone by the time the
      -- picture changes, and the language on the pill alone does not say which track that was.
      mp.add_timeout(0.05, guard(function()
        local state = track_state(kind)
        toast(string.format('%s  %s  %s', kind == 'audio' and 'Audio' or 'Subtitles',
          state.text, track_name(state.track)))
      end))
    end
  elseif id:sub(1, 9) == 'subdelay:' then
    -- Positive is later, as mpv has it: a subtitle that arrives before the line is spoken needs
    -- a positive delay. The menu stays open, because a step is rarely the last one.
    local value = id:sub(10)
    if value == 'reset' then
      mp.set_property_number('sub-delay', 0)
    else
      mp.commandv('add', 'sub-delay', value)
    end
  elseif id == 'fullscreen' then
    -- Embedded, mpv cannot take the screen for itself — the window it draws into is not its own.
    -- Flipping the property is still the whole job: StreamHub observes it and puts *its* window
    -- into fullscreen, which is the only thing that could have worked anyway.
    mp.set_property_bool('fullscreen', not mp.get_property_bool('fullscreen'))
  elseif id == 'close' then
    -- Leaving is the app's decision, not the player's. Neither `quit` nor `stop` is right: the app
    -- keeps this process alive and idle between episodes, and from fullscreen "back" means leaving
    -- fullscreen first. So this says what the user asked for and lets the app do it — the same
    -- message Escape sends there.
    mp.commandv('script-message', 'streamhub-escape')
  end
end

local on_mouse = guard(function(_, value)
  if type(value) ~= 'table' then return end
  local moved = value.x ~= mouse.x or value.y ~= mouse.y
  mouse.x = value.x or -1
  mouse.y = value.y or -1
  mouse.hover = value.hover ~= false
  if not mouse.hover then
    -- The pointer left the window entirely; there is nobody to keep the bar up for.
    if not should_stay() then hide() end
    return
  end
  if moved then wake() end
  local function within(box)
    return box ~= nil
      and mouse.x >= box.x and mouse.x <= box.x + box.w
      and mouse.y >= box.y and mouse.y <= box.y + box.h
  end
  local on_glass = shown and (within(slab) or within(menu_box))
  suppress_window_drag(on_glass or drag ~= nil)
  if not drag then return end
  local L = layout()
  if not L then return end
  if drag == 'seek' then
    apply_seek(L, mouse.x, false)
  else
    apply_volume(L, mouse.x)
  end
end)

local function press()
  -- A click on controls that cannot be seen only brings them back. Their regions outlive the fade,
  -- so without this a click on the picture where the bar had been would press whatever was there —
  -- pause, or the X that leaves the film.
  local was_hidden = not shown or vis_target == 0
  wake()
  if was_hidden then
    pressed = nil
    return
  end
  local L = layout()
  if not L then return end
  local at = region_at(mouse.x, mouse.y)
  -- A press anywhere that is not the menu or the button that opened it dismisses the menu, which
  -- is what a click outside a menu does everywhere else. Checked before the press is acted on, so
  -- the click that closes it still does whatever it landed on.
  if menu then
    local id = at and at.id or ''
    local own = id:sub(1, 6) == 'track:' or id:sub(1, 9) == 'subdelay:'
      or id == (menu.kind == 'audio' and 'audio' or 'subs')
    -- The menu's own glass — its heading, its padding, the gaps between the timing buttons — is
    -- part of the menu. A click there is a near miss on something in it, not a click outside it,
    -- and it must not fall through to whatever the menu is standing over either.
    if not own and pointer_in(menu_box) then
      pressed = nil
      render()
      return
    end
    if not own then close_menu() end
  end
  if not at then
    pressed = nil
    return
  end
  pressed = at.id
  suppress_window_drag(true)
  if at.id == 'seek' then
    drag = 'seek'
    apply_seek(L, mouse.x, false)
  elseif at.id == 'volume' then
    drag = 'volume'
    apply_volume(L, mouse.x)
  end
  render()
end

local function release()
  last_input = mp.get_time()
  if drag == 'seek' then
    local L = layout()
    if L then apply_seek(L, mouse.x, true) end
    -- Let go of the pointer, but not of where it was pointing: the exact seek above is still on
    -- its way, and until it lands the file's own position is the *old* one. See seek_target.
    if drag_pos then
      seek_target = drag_pos
      seek_target_until = mp.get_time() + SEEK_LATCH
    end
  end
  drag, drag_pos = nil, nil
  -- A button fires on release, over the control it went down on: pressing one and sliding off it
  -- is how every toolbar in the world lets you change your mind.
  if pressed and pressed ~= 'seek' and pressed ~= 'volume' then
    local at = region_at(mouse.x, mouse.y)
    if at and at.id == pressed then activate(pressed) end
  end
  pressed = nil
  render()
end

-- 'press' is a whole click arriving at once, which is what a synthetic one (the `keypress`
-- command, a remote) looks like; a pointer sends 'down' and 'up' either side of whatever drag
-- happens between them.
local on_click = guard(function(event)
  local state = type(event) == 'table' and event.event or 'press'
  if state == 'down' then
    press()
  elseif state == 'up' then
    release()
  elseif state == 'press' then
    press()
    release()
  end
end)

-- ---------------------------------------------------------------------------------------------
-- Wiring
-- ---------------------------------------------------------------------------------------------

mp.observe_property('mouse-pos', 'native', on_mouse)

-- A property that changes what the bar says should redraw it now and bring it back if it has
-- gone: these are all things the user just did, or things they are waiting to see.
for _, name in ipairs({
  'mute', 'volume', 'track-list', 'aid', 'sid', 'fullscreen',
  'playlist-count', 'paused-for-cache',
}) do
  mp.observe_property(name, 'native', guard(function()
    if shown then render() else wake() end
  end))
end
-- These only redraw. A chapter changing is the film playing on, not anything the user did — waking
-- the bar for it would darken the picture under the title card at every chapter of every film.
-- Stepping chapters from the bar wakes it through the click anyway.
for _, name in ipairs({ 'media-title', 'duration', 'chapter-list', 'chapter' }) do
  mp.observe_property(name, 'native', guard(function()
    if shown then render() end
  end))
end

-- Pause, separately, because it is also answered in the middle of the picture. Only once the file
-- is open and only on a real change: the value mpv reports as a file loads is not something the
-- user did, and a disc swelling out of a film that has not started yet would be noise.
local last_pause = nil
mp.observe_property('pause', 'bool', guard(function(_, paused)
  if file_ready and last_pause ~= nil and paused ~= last_pause
    and not mp.get_property_bool('idle-active') then
    flash = { glyph = paused and 'pause' or 'play', t0 = mp.get_time() }
    animate()
  end
  last_pause = paused
  if shown then render() else wake() end
end))

-- Subtitle timing, however it was changed — the timing row, or the z and x keys. The keys are
-- rebound without mpv's own on-screen message (see src/mpv.js), which landed in the corner the
-- title card now occupies, so this toast is their feedback too. Said in words rather than as a
-- signed number, because "+0.3" does not tell anyone which way the subtitles went.
--
-- Not while the subtitle menu is open: the readout in it already says it, and the toast would sit
-- beside the menu repeating it. And not for the reset a new file brings (see start-file below),
-- which nobody asked for.
local delay_reset_pending = false
mp.observe_property('sub-delay', 'number', guard(function(_, delay)
  if delay == nil then return end
  if delay_reset_pending then
    delay_reset_pending = false
    return
  end
  if not file_ready then return end
  if not (menu and menu.kind == 'sub') then
    if math.abs(delay) < 0.05 then
      toast('Subtitles  in sync with the file')
    else
      toast(string.format('Subtitles  %.1f s %s', math.abs(delay), delay > 0 and 'later' or 'earlier'))
    end
  end
  if shown then render() else wake() end
end))

-- A timing fix belongs to the subtitle file it was made for. mpv stays running from one episode to
-- the next and sub-delay is a player-wide option, so without this the half-second an earlier film
-- needed would quietly be applied to the next one, whose subtitles were fine.
mp.register_event('start-file', guard(function()
  if (mp.get_property_number('sub-delay') or 0) ~= 0 then
    delay_reset_pending = true
    mp.set_property_number('sub-delay', 0)
  end
end))

-- A different file is a different timeline, so a position aimed at in the last one means nothing
-- here and holding it would show the new film starting somewhere it is not.
mp.register_event('file-loaded', guard(function()
  seek_target = nil
  file_ready = true
  last_pause = mp.get_property_bool('pause')
  -- A different file has different tracks, so a list of the last one's is no longer a list of
  -- anything.
  close_menu()
  wake()
end))
mp.register_event('end-file', guard(function()
  seek_target = nil
  file_ready = false
  flash = nil
  render_flash()
  close_menu()
  wake()
end))
mp.register_event('shutdown', guard(function()
  -- Hand back what was borrowed: the window's own dragging, and the keys an open menu took.
  suppress_window_drag(false)
  close_menu()
end))

mp.add_forced_key_binding('MBTN_LEFT', 'streamhub-osc-click', on_click, { complex = true })

-- Double-click. mpv makes one out of any two presses close together, whatever they landed on, and
-- its default binding for it is fullscreen — so two quick presses of a skip button, or of the
-- subtitle timing steps, which are made to be pressed repeatedly, would throw the whole app in or
-- out of fullscreen. Over the controls the two presses were two clicks and have been handled as
-- such; on the picture a double-click still means fullscreen, as it does in every player.
mp.add_forced_key_binding('MBTN_LEFT_DBL', 'streamhub-osc-dblclick', guard(function()
  if shown and vis_target > 0
    and (region_at(mouse.x, mouse.y) or pointer_in(slab) or pointer_in(menu_box)) then
    return
  end
  mp.commandv('cycle', 'fullscreen')
end))

mp.add_periodic_timer(FRAME, tick)

-- Up on arrival: at that point nothing is playing yet, so there is nothing for it to be in the way
-- of, and it is how the user finds out the controls exist.
wake()
