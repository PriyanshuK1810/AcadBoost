import { Link } from 'react-router'
import { PRODUCT_BRAND } from './brand'

export default function BrandWordmark({
  className,
  href,
  to,
  tagline,
  onClick,
}) {
  const contents = (
    <>
      {PRODUCT_BRAND}
      <span aria-hidden="true">.</span>
      {tagline && <small>{tagline}</small>}
    </>
  )
  const commonProps = {
    className,
    onClick,
    'aria-label': `${PRODUCT_BRAND} home`,
  }

  if (to) {
    return (
      <Link {...commonProps} to={to}>
        {contents}
      </Link>
    )
  }
  if (href) {
    return (
      <a {...commonProps} href={href}>
        {contents}
      </a>
    )
  }
  return <span className={className}>{contents}</span>
}
