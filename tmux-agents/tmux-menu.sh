#!/usr/bin/env bash
#
# Right-click menu for a window's tab in the tmux status bar.
#
# The tmux-agents Pi extension binds this to MouseDown3Status. It also works
# on its own:
#
#   bind-key -n MouseDown3Status run-shell -b -t = \
#     "bash /path/to/tmux-menu.sh menu '#{client_name}' '#{pane_id}'"
#
# Moving panes between windows is safe for agents spawned by tmux-agents:
# they are tracked by pane ID, which join-pane and break-pane keep.

set -euo pipefail

SELF="$(realpath "${BASH_SOURCE[0]}")"

usage() {
  echo "usage: $0 {menu CLIENT PANE | panes-to-windows WINDOW | join CLIENT WINDOW WINDOW | send-left WINDOW | send-right WINDOW | send-end WINDOW | layout-menu CLIENT PANE | focus-pane PANE}" >&2
  exit 2
}

# Menu commands are tmux command strings that run this script again, so its
# path and every ID passed to it must survive tmux and shell parsing as is.
safe_word() {
  [[ "$1" =~ ^[A-Za-z0-9_./%@-]+$ ]]
}

require_window() {
  [[ "${1:-}" =~ ^@[0-9]+$ ]] || { echo "tmux-menu: invalid window ID: ${1:-}" >&2; exit 2; }
}

require_pane() {
  [[ "${1:-}" =~ ^%[0-9]+$ ]] || { echo "tmux-menu: invalid pane ID: ${1:-}" >&2; exit 2; }
}

require_client() {
  [[ -n "${1:-}" ]] && safe_word "$1" || { echo "tmux-menu: unsupported client name: ${1:-}" >&2; exit 2; }
}

safe_word "$SELF" || { echo "tmux-menu: unsupported characters in path: $SELF" >&2; exit 2; }

# Menu titles and labels are format-expanded by tmux, and #(...) in a format
# runs a shell command. Doubling every # shows a window name literally.
label() {
  printf '%s' "${1//#/##}"
}

# A greyed-out menu item. tmux disables items whose label starts with "-".
disabled() {
  printf -- '-%s' "$(label "$1")"
}

# Text for inside a double-quoted string in a tmux command, which is also
# format-expanded. Escape backslashes, quotes and $ (environment variables),
# then double #.
quoted() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//\$/\\\$}"
  printf '%s' "${text//#/##}"
}

# A menu command that runs this script in the background with the given words.
run_self() {
  printf 'run-shell -b "bash %s %s"' "$SELF" "$*"
}

window_rows() {
  local session="$1"

  tmux list-windows \
    -t "$session" \
    -F '#{window_id}|#{window_index}|#{window_name}' \
    | sort -t'|' -k2,2n
}

active_pane() {
  local window="$1"

  tmux list-panes \
    -t "$window" \
    -f '#{pane_active}' \
    -F '#{pane_id}' \
    | head -n 1
}

adjacent_window() {
  local source_window="$1"
  local offset="$2"

  local session
  session="$(tmux display-message -p -t "$source_window" '#{session_id}')"

  local rows
  mapfile -t rows < <(window_rows "$session")

  local pos=-1 i wid idx name

  for i in "${!rows[@]}"; do
    IFS='|' read -r wid idx name <<< "${rows[$i]}"

    if [[ "$wid" == "$source_window" ]]; then
      pos="$i"
      break
    fi
  done

  local target=$((pos + offset))

  if (( pos < 0 || target < 0 || target >= ${#rows[@]} )); then
    return 1
  fi

  IFS='|' read -r wid idx name <<< "${rows[$target]}"

  printf '%s\n' "$wid"
}

case "${1:-}" in

  menu)
    client="${2:-}"
    source_pane="${3:-}"
    require_client "$client"
    require_pane "$source_pane"

    IFS='|' read -r \
      session \
      source_window \
      source_index \
      pane_count \
      source_name <<< \
      "$(tmux display-message \
          -p \
          -t "$source_pane" \
          '#{session_id}|#{window_id}|#{window_index}|#{window_panes}|#{window_name}')"

    mapfile -t rows < <(window_rows "$session")

    prev_window=""
    next_window=""
    last_window=""
    source_pos=-1

    for i in "${!rows[@]}"; do
      IFS='|' read -r wid idx name <<< "${rows[$i]}"

      last_window="$wid"

      if [[ "$wid" == "$source_window" ]]; then
        source_pos="$i"
      fi
    done

    if (( source_pos > 0 )); then
      IFS='|' read -r prev_window _ _ <<< \
        "${rows[$((source_pos - 1))]}"
    fi

    if (( source_pos >= 0 && source_pos < ${#rows[@]} - 1 )); then
      IFS='|' read -r next_window _ _ <<< \
        "${rows[$((source_pos + 1))]}"
    fi

    items=()

    # Layout controls come from layout.mjs, which names itself in the
    # window's @piao_script option. Windows it doesn't manage leave these out.
    layout_script="$(tmux show-options -wqv -t "$source_window" @piao_script)"
    if [[ -n "$layout_script" && -f "$layout_script" ]]; then
      items+=(
        "Layout..." "L"
        "$(run_self layout-menu "$client" "$source_pane")"
        "Focus / Restore active agent" "f"
        "$(run_self focus-pane "$source_pane")"
        ""
      )
    fi

    # ── Pane/window conversion ──

    if (( pane_count > 1 )); then
      items+=(
        "Panes to Windows" "P"
        "$(run_self panes-to-windows "$source_window")"
      )
    else
      items+=("$(disabled "Panes to Windows")" "" "")
    fi

    items+=("")

    # ── Join into another window ──

    for row in "${rows[@]}"; do
      IFS='|' read -r wid idx name <<< "$row"

      if [[ "$wid" != "$source_window" ]]; then
        items+=(
          "$(label "Join $idx:$name")" ""
          "$(run_self join "$client" "$source_window" "$wid")"
        )
      fi
    done

    items+=("")

    # ── Window ordering ──

    if [[ -n "$prev_window" ]]; then
      items+=("Send Left" "l" "$(run_self send-left "$source_window")")
    else
      items+=("$(disabled "Send Left")" "" "")
    fi

    if [[ -n "$next_window" ]]; then
      items+=("Send Right" "r" "$(run_self send-right "$source_window")")
    else
      items+=("$(disabled "Send Right")" "" "")
    fi

    if [[ "$source_window" != "$last_window" ]]; then
      items+=("Send to End" "e" "$(run_self send-end "$source_window")")
    else
      items+=("$(disabled "Send to End")" "" "")
    fi

    items+=("")

    # ── Normal window operations ──
    # Both target the clicked window by ID, not the client's current window.
    # Renaming changes the tab label only: tmux-agents still addresses an
    # agent by the name it was spawned with.

    items+=(
      "Rename" "n"
      "command-prompt -I \"$(quoted "$source_name")\" -p \"Rename window:\" { rename-window -t $source_window -- \"%%\" }"
      "Kill" "X"
      "confirm-before -p \"Kill window $(quoted "$source_index:$source_name")? (y/n)\" \"kill-window -t $source_window\""
    )

    options=(
      -c "$client"
      -t "$source_pane"
      -T "$(label "$source_index:$source_name")"
      -x W
      -y S
    )

    # -M and -O need a recent tmux. Older versions show the same menu without them.
    tmux display-menu -M -O "${options[@]}" "${items[@]}" 2>/dev/null \
      || tmux display-menu "${options[@]}" "${items[@]}"
    ;;

  panes-to-windows)
    source_window="${2:-}"
    require_window "$source_window"

    mapfile -t panes < <(
      tmux list-panes \
        -t "$source_window" \
        -F '#{pane_index}|#{pane_id}' \
        | sort -t'|' -k1,1n \
        | cut -d'|' -f2
    )

    if (( ${#panes[@]} <= 1 )); then
      exit 0
    fi

    # One pane has to remain in the original window.
    # Keep pane 0 there and break every other pane into its own window.
    for pane in "${panes[@]:1}"; do
      tmux break-pane -d -s "$pane"
    done
    ;;

  join)
    client="${2:-}"
    source_window="${3:-}"
    destination_window="${4:-}"
    require_client "$client"
    require_window "$source_window"
    require_window "$destination_window"

    [[ "$source_window" == "$destination_window" ]] && exit 0

    destination_pane="$(active_pane "$destination_window")"

    mapfile -t panes < <(
      tmux list-panes \
        -t "$source_window" \
        -F '#{pane_index}|#{pane_id}' \
        | sort -t'|' -k1,1n \
        | cut -d'|' -f2
    )

    # Move every pane from the clicked window into the selected
    # destination window.
    for pane in "${panes[@]}"; do
      tmux join-pane \
        -d \
        -h \
        -s "$pane" \
        -t "$destination_pane"
    done

    # Windows managed by layout.mjs use their remembered layout. Ordinary
    # windows are laid out side by side.
    layout_script="$(tmux show-options -wqv -t "$destination_window" @piao_script)"
    if [[ -n "$layout_script" && -f "$layout_script" ]]; then
      node "$layout_script" reflow "$destination_window"
    else
      tmux select-layout -t "$destination_window" even-horizontal >/dev/null
    fi

    # Land the client in the window we just joined everything into.
    tmux switch-client \
      -c "$client" \
      -t "$destination_pane"
    ;;

  layout-menu)
    client="${2:-}"
    pane="${3:-}"
    require_client "$client"
    require_pane "$pane"
    layout_script="$(tmux show-options -wqv -t "$pane" @piao_script)"
    [[ -n "$layout_script" && -f "$layout_script" ]] || exit 0
    exec node "$layout_script" layout-menu "$client" "$pane"
    ;;

  focus-pane)
    require_pane "${2:-}"
    tmux resize-pane -Z -t "$2"
    ;;

  send-left | send-right)
    source_window="${2:-}"
    require_window "$source_window"

    offset=$([[ "$1" == send-left ]] && echo -1 || echo 1)
    target="$(adjacent_window "$source_window" "$offset")" || exit 0

    tmux swap-window \
      -s "$source_window" \
      -t "$target"
    ;;

  send-end)
    source_window="${2:-}"
    require_window "$source_window"

    session="$(
      tmux display-message \
        -p \
        -t "$source_window" \
        '#{session_id}'
    )"

    mapfile -t rows < <(window_rows "$session")

    source_pos=-1

    for i in "${!rows[@]}"; do
      IFS='|' read -r wid idx name <<< "${rows[$i]}"

      if [[ "$wid" == "$source_window" ]]; then
        source_pos="$i"
        break
      fi
    done

    (( source_pos >= 0 )) || exit 0

    # Repeated adjacent swaps move the window to the end while keeping
    # the indexes contiguous.
    for ((i = source_pos + 1; i < ${#rows[@]}; i++)); do
      IFS='|' read -r target _ _ <<< "${rows[$i]}"

      tmux swap-window \
        -s "$source_window" \
        -t "$target"
    done
    ;;

  *)
    usage
    ;;
esac
