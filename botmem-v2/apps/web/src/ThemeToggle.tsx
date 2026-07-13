import { useTheme } from './theme.js';

export function ThemeToggle() {
  const [theme, toggleTheme] = useTheme();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label={`Use ${nextTheme} theme`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☼' : '◐'}</span>
      {theme === 'dark' ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
