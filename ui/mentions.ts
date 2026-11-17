const mentions = /(^|\s)(@agent)(?=$|[\s.,!?:;])/gi;

export function renderMentions(root: HTMLElement, text: string) {
  root.replaceChildren();
  let offset = 0;
  for (const match of text.matchAll(mentions)) {
    const start = match.index + match[0].length - "@agent".length;
    if (start > offset) root.append(text.slice(offset, start));
    const mark = document.createElement("strong");
    mark.className = "board-chat-mention";
    mark.textContent = text.slice(start, start + "@agent".length);
    root.append(mark);
    offset = start + "@agent".length;
  }
  if (offset < text.length) root.append(text.slice(offset));
}

function caret(editor: HTMLElement, end: "focus" | "anchor" = "focus") {
  const selection = getSelection();
  const node = end === "focus" ? selection?.focusNode : selection?.anchorNode;
  if (!selection || !node || !editor.contains(node)) return editor.textContent?.length ?? 0;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(node, end === "focus" ? selection.focusOffset : selection.anchorOffset);
  return range.toString().length;
}

export function mentionEditor(editor: HTMLElement, suggestion: HTMLButtonElement, onSend: () => void) {
  let start: number | null = null;
  const current = () => editor.textContent ?? "";
  function dismiss() {
    suggestion.hidden = true;
    start = null;
  }
  function write(text: string, position = text.length) {
    text = text.slice(0, 2000);
    const formatted = document.createElement("div");
    renderMentions(formatted, text);
    if (formatted.innerHTML !== editor.innerHTML || caret(editor) !== position) {
      editor.replaceChildren(...Array.from(formatted.childNodes));
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let remaining = Math.min(position, text.length);
      let node = walker.nextNode();
      while (node instanceof Text && remaining > node.length) {
        remaining -= node.length;
        node = walker.nextNode();
      }
      if (node) getSelection()?.collapse(node, remaining);
      else getSelection()?.collapse(editor, 0);
    }
    dismiss();
  }
  function suggest() {
    const position = caret(editor);
    const prefix = current().slice(0, position).match(/(?:^|\s)(@[a-z]*)$/i)?.[1];
    start = prefix && "@agent".startsWith(prefix.toLowerCase()) ? position - prefix.length : null;
    suggestion.hidden = start === null;
  }
  function insert() {
    if (start === null) return;
    const position = caret(editor);
    const text = current();
    const suffix = text.slice(position).match(/^[a-z]*/i)?.[0] ?? "";
    write(text.slice(0, start) + "@agent " + text.slice(position + suffix.length).trimStart(), start + "@agent ".length);
  }
  function insertText(text: string) {
    const focus = caret(editor);
    const anchor = caret(editor, "anchor");
    const from = Math.min(focus, anchor);
    const to = Math.max(focus, anchor);
    write(current().slice(0, from) + text + current().slice(to), from + text.length);
    suggest();
  }
  editor.addEventListener("paste", (event) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    insertText(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
  });
  editor.addEventListener("beforeinput", (event) => {
    if (!(event instanceof InputEvent) || !event.data?.includes("\n") || event.isComposing || !event.cancelable) return;
    event.preventDefault();
    insertText(event.data);
  });
  editor.addEventListener("input", (event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    write(current(), caret(editor));
    suggest();
  });
  editor.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" && !suggestion.hidden) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    } else if (!suggestion.hidden && ["Enter", "Tab"].includes(event.key) && !event.shiftKey) {
      event.preventDefault();
      insert();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        insertText("\n");
      } else onSend();
    }
  });
  editor.addEventListener("blur", dismiss);
  suggestion.addEventListener("pointerdown", (event) => event.preventDefault());
  suggestion.addEventListener("click", insert);
  return {
    current,
    clear: () => write(""),
    mention: () => {
      editor.focus();
      if (!current().match(mentions)) write("@agent " + current());
    },
  };
}
