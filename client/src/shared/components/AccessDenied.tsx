import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';

export function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-20 sm:py-28">
      <ShieldAlert className="w-10 h-10 text-red-500 mb-3" />
      <h2 className="text-lg font-semibold text-gray-900">Access denied</h2>
      <p className="text-sm text-gray-500 mt-1 max-w-sm">
        Your role doesn't have permission to view this page. If you think this is a mistake, ask an admin to update your role.
      </p>
      <Link to="/dashboard" className="mt-5 text-sm font-medium text-indigo-600 hover:text-indigo-700">
        Back to Dashboard
      </Link>
    </div>
  );
}
