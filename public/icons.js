export function icon(name, className = '') {
  return `<svg class="ui-icon${className ? ` ${className}` : ''}" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
}
