interface PageContainerProps {
  children: React.ReactNode;
}

export function PageContainer({ children }: PageContainerProps) {
  return <div className="p-6 max-w-[1400px] w-full overflow-hidden">{children}</div>;
}
