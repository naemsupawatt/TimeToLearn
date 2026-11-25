"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type BrickColor = "red" | "blue" | "green" | "yellow";

const menu: { href: string; label: string; color: BrickColor; studs: number }[] = [
  { href: "/", label: "Home", color: "blue", studs: 2 },
  { href: "/my-class-room", label: "My Class Room", color: "green", studs: 4 },
];

const login = { href: "/login", label: "Login", color: "red" as BrickColor, studs: 2 };

function Studs({ count }: { count: number }) {
  return (
    <span className="brick-studs" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="stud" />
      ))}
    </span>
  );
}

function BrickLink({
  href,
  label,
  color,
  studs,
  active,
  onClick,
  className = "",
}: {
  href: string;
  label: string;
  color: BrickColor;
  studs: number;
  active: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`brick brick-${color} px-5 py-2 text-base font-semibold ${className}`}
    >
      <Studs count={studs} />
      {label}
    </Link>
  );
}

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="TimeToLearn home">
      {/* 2x2 brick icon */}
      <span className="brick brick-red brick-static grid h-10 w-10 place-items-center" aria-hidden="true">
        <Studs count={2} />
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="white" strokeWidth={2.5} strokeLinecap="round">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      </span>
      <span className="logo-text text-2xl font-bold tracking-tight sm:text-3xl">
        <span className="text-lego-red">Time</span>
        <span className="text-lego-blue">To</span>
        <span className="text-lego-green">Learn</span>
      </span>
    </Link>
  );
}

export default function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="baseplate sticky top-0 z-50 font-lego">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 pb-4 pt-5 sm:px-6"
      >
        <Logo />

        {/* Desktop menu */}
        <ul className="hidden items-center gap-4 md:flex">
          {menu.map((item) => (
            <li key={item.href}>
              <BrickLink {...item} active={isActive(item.href)} />
            </li>
          ))}
          <li className="ml-2">
            <BrickLink {...login} active={isActive(login.href)} />
          </li>
        </ul>

        {/* Mobile toggle */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className="brick brick-blue grid h-11 w-12 place-items-center md:hidden"
        >
          <Studs count={2} />
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" />
            )}
          </svg>
        </button>
      </nav>

      {/* Mobile menu */}
      <ul
        id="mobile-menu"
        hidden={!open}
        className="mx-auto flex max-w-6xl flex-col gap-5 px-4 pb-6 pt-3 md:hidden"
      >
        {[...menu, login].map((item) => (
          <li key={item.href}>
            <BrickLink
              {...item}
              active={isActive(item.href)}
              onClick={close}
              className="flex w-full justify-center"
            />
          </li>
        ))}
      </ul>
    </header>
  );
}
