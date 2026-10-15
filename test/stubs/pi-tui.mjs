// Stand-in for Pi's bundled @earendil-works/pi-tui. Widths are plain string lengths, and keys
// arrive as keybinding ids ("tui.input.submit"), like the stub keybindings the tests pass to custom().
export const truncateToWidth = (text, width) => text.slice(0, Math.max(0, width));
export const matchesKey = (data, key) => data === key;

export function wrapTextWithAnsi(text, width) {
  const rows = [];
  for (let i = 0; i < text.length; i += width) rows.push(text.slice(i, i + width));
  return rows.length > 0 ? rows : [""];
}

export class Input {
  value = "";
  cursor = 0;
  focused = false;
  getValue() { return this.value; }
  setValue(value) {
    this.value = value;
    this.cursor = Math.min(this.cursor, value.length);
  }
  handleInput(data) {
    if (data === "tui.select.cancel") this.onEscape?.();
    else if (data === "tui.input.submit") this.onSubmit?.(this.value);
    else if (data === "backspace") {
      if (this.cursor === 0) return;
      this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
      this.cursor--;
    } else {
      this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
      this.cursor += data.length;
    }
  }
  render(width) { return [`> ${this.value}`.slice(0, width)]; }
}
