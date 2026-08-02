// overleaf-lab: the pieces the two admin pages share. Splitting the compliance
// settings onto their own page would otherwise have meant two copies of these
// styles, which drift the moment one page is restyled and the other is not.
import React from 'react'

export const sectionStyle: React.CSSProperties = {
    padding: '1.5rem',
    borderRadius: '8px',
    border: '1px solid var(--border-color-01, #dee2e6)',
    backgroundColor: 'var(--bg-light-primary, #fff)',
    marginBottom: '1.25rem',
}

export const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.25rem',
    fontSize: '1.1rem',
    fontWeight: 600,
}

export const sectionDescStyle: React.CSSProperties = {
    color: 'var(--content-secondary, #6c757d)',
    fontSize: '0.875rem',
    marginBottom: '1.25rem',
}

export const statusBadgeStyle = (
    variant: 'success' | 'error'
): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    fontSize: '0.8125rem',
    fontWeight: 500,
    color:
        variant === 'success'
            ? 'var(--green-60, #198754)'
            : 'var(--red-60, #dc3545)',
})

export const stepNumberStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: '50%',
    backgroundColor: 'var(--bg-accent-01, #0d6efd)',
    color: '#fff',
    fontSize: '0.75rem',
    fontWeight: 700,
    flexShrink: 0,
}

// overleaf-lab: a small accessible toggle switch (styled from a button) used for
// the per-feature enable/disable controls.
export function ToggleSwitch({
    checked,
    onChange,
    label,
}: {
    checked: boolean
    onChange: (v: boolean) => void
    label?: string
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            style={{
                position: 'relative',
                width: 42,
                height: 24,
                flexShrink: 0,
                borderRadius: 999,
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                transition: 'background-color 0.15s',
                backgroundColor: checked
                    ? 'var(--bg-accent-01, #0d6efd)'
                    : 'var(--border-color-02, #adb5bd)',
            }}
        >
            <span
                style={{
                    position: 'absolute',
                    top: 3,
                    left: checked ? 21 : 3,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    backgroundColor: '#fff',
                    transition: 'left 0.15s',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                }}
            />
        </button>
    )
}
