import { Link } from 'react-router-dom';
import { Logo } from '../ui/Logo';

const GITHUB_URL = 'https://github.com/botmem/botmem';

export function PublicFooter() {
  return (
    <footer className="border-t-4 border-nb-border py-8 px-4 sm:px-6">
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-sm text-nb-muted">
          <Logo variant="full" height={24} />
          <div className="flex flex-wrap justify-center gap-6">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
            >
              GitHub
            </a>
            <a
              href={`${GITHUB_URL}#readme`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
            >
              Docs
            </a>
            <a
              href="/#pricing"
              className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
            >
              Pricing
            </a>
          </div>
        </div>
        <div className="flex flex-wrap justify-center sm:justify-end gap-6 font-mono text-xs text-nb-muted">
          <Link
            to="/privacy"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            Privacy Policy
          </Link>
          <Link
            to="/terms"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            Terms of Service
          </Link>
          <Link
            to="/data-policy"
            className="hover:text-nb-text transition-colors duration-200 cursor-pointer"
          >
            Data Policy
          </Link>
        </div>
        <div className="border-t border-nb-border/30 pt-4 flex justify-center">
          <p className="font-mono text-xs text-nb-muted">
            &copy; {new Date().getFullYear()} Botmem. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
