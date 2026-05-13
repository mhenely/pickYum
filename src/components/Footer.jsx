import { Link } from 'react-router-dom';

const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

const Footer = () => (
  <footer className="bg-gradient-to-r from-orange-50 to-amber-50 border-t border-orange-200 mt-auto">
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-6">

        {/* Brand */}
        <Link to="/" onClick={scrollTop} className="flex items-center gap-2">
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 text-base shadow-brand-sm select-none">🍽</span>
          <span className="font-display font-extrabold text-lg tracking-tight bg-gradient-to-br from-orange-600 to-red-600 bg-clip-text text-transparent">pickYum</span>
        </Link>

        {/* Links */}
        <nav className="flex items-center gap-6 text-sm">
          <Link to="/about" onClick={scrollTop} className="text-stone-500 hover:text-orange-600 transition-colors">
            About
          </Link>
          <Link to="/" onClick={scrollTop} className="text-stone-500 hover:text-orange-600 transition-colors">
            Search
          </Link>
        </nav>

        {/* Copyright */}
        <p className="text-xs text-stone-400">
          © {new Date().getFullYear()} pickYum. All rights reserved.
        </p>
      </div>
    </div>
  </footer>
);

export default Footer;
