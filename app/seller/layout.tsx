// Страница /seller открывается по ссылке со своим логином и паролем (app/api/sellers/login), без входа в портал, поэтому здесь нет AppShell.
export default function SellerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
