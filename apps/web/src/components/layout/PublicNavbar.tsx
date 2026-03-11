import { Link } from 'react-router-dom';
import { Logo } from '../ui/Logo';
import { ThemeToggle } from '../ui/ThemeToggle';

const NAV_LINKS = [
  { to: '/#features', label: 'FEATURES' },
  { to: '/pricing', label: 'PRICING' },
  { to: '/#security', label: 'SECURITY' },
  { to: '/#open-source', label: 'OPEN SOURCE' },
];

export function PublicNavbar() {
  return (
    <nav
      className="sticky top-0 z-40 bg-nb-bg/95 backdrop-blur-sm border-b-4 border-nb-border"
      aria-label="Main navigation"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
        <Link to="/" aria-label="Botmem home" className="cursor-pointer">
          <Logo variant="full" height={28} />
        </Link>
        <div className="hidden sm:flex items-center gap-6 font-display text-sm tracking-wide">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="text-nb-muted hover:text-nb-text transition-colors duration-200 cursor-pointer"
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link
            to="/signup"
            className="font-display text-sm font-bold px-5 py-2 bg-nb-lime text-black border-3 border-nb-border shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] transition-all duration-150 cursor-pointer"
          >
            GET STARTED
          </Link>
        </div>
      </div>
    </nav>
  );
}
