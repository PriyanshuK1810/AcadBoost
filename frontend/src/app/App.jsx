import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Route,
  RouterProvider,
} from 'react-router'
import { PRODUCT_BRAND } from './brand'
import PasswordAuthPage from '../features/auth/PasswordAuthPage'
import AccountRecoveryPage from '../features/auth/AccountRecoveryPage'
import PhoneLoginPage from '../features/auth/PhoneLoginPage'
import GoogleLoginPage from '../features/auth/GoogleLoginPage'
import AccountPage from '../features/auth/AccountPage'
import ReviewPage from '../features/review/ReviewPage'
import WorkspaceShell from '../features/workspace/components/WorkspaceShell'
import OrganizationsPage from '../features/workspace/pages/OrganizationsPage'
import OrganizationDetailPage from '../features/workspace/pages/OrganizationDetailPage'
import StudentDashboardPage from '../features/workspace/pages/StudentDashboardPage'
import StudentRoadmapPage from '../features/workspace/pages/StudentRoadmapPage'
import StudentActivityPage from '../features/workspace/pages/StudentActivityPage'
import StudentDeadlinesPage from '../features/workspace/pages/StudentDeadlinesPage'
import CoordinatorDashboardPage from '../features/workspace/pages/CoordinatorDashboardPage'
import CohortsPage from '../features/workspace/pages/CohortsPage'
import ActivityPlanPage from '../features/workspace/pages/ActivityPlanPage'
import ActivityPlanUploadPage from '../features/workspace/pages/ActivityPlanUploadPage'
import RoadmapsPage from '../features/workspace/pages/RoadmapsPage'
import RoadmapVersionsPage from '../features/workspace/pages/RoadmapVersionsPage'
import ImportsPage from '../features/workspace/pages/ImportsPage'
import StudentProgressPage from '../features/workspace/pages/StudentProgressPage'
import TopicStatisticsPage from '../features/workspace/pages/TopicStatisticsPage'
import AtRiskPage from '../features/workspace/pages/AtRiskPage'
import CoordinatorLearningPage from '../features/workspace/pages/CoordinatorLearningPage'
import StudentLearningPage from '../features/workspace/pages/StudentLearningPage'
import LiveCohortProgressPage from '../features/workspace/pages/LiveCohortProgressPage'
import './workspace.css'
import '../styles/public-pages.css'
import MarketingPage from '../pages/marketing/MarketingPage'
function NotFoundPage() {
  return (
    <main className="page-container not-found-page">
      <p className="eyebrow">Page not found</p>
      <h1>We couldn’t find that page.</h1>
      <p>Check the address or return to the homepage.</p>
      <a className="button button-primary" href="/">
        Back to {PRODUCT_BRAND}
      </a>
    </main>
  )
}
export default function App() {
  const router = createBrowserRouter(createRoutesFromElements(<>{routes}</>))
  return <RouterProvider router={router} />
}
const routes = (
  <>
    <Route path="/" element={<MarketingPage />} />
    <Route path="/login" element={<PasswordAuthPage mode="login" />} />
    <Route path="/register" element={<PasswordAuthPage mode="register" />} />
    <Route path="/auth/phone" element={<PhoneLoginPage />} />
    <Route path="/auth/google" element={<GoogleLoginPage />} />
    <Route
      path="/auth/forgot-password"
      element={<AccountRecoveryPage mode="forgot" />}
    />
    <Route
      path="/auth/reset-password"
      element={<AccountRecoveryPage mode="reset" />}
    />
    <Route
      path="/auth/verify-email"
      element={<AccountRecoveryPage mode="verify" />}
    />
    <Route
      path="/reset-password"
      element={<AccountRecoveryPage mode="reset" />}
    />
    <Route
      path="/verify-email"
      element={<AccountRecoveryPage mode="verify" />}
    />
    <Route path="/review" element={<ReviewPage view="walkthrough" />} />
    <Route
      path="/review/student"
      element={<Navigate to="/app/student" replace />}
    />
    <Route
      path="/review/coordinator"
      element={<Navigate to="/app/coordinator" replace />}
    />
    <Route path="/review/status" element={<ReviewPage view="status" />} />
    <Route path="/app" element={<WorkspaceShell />}>
      <Route index element={<Navigate to="student" replace />} />
      <Route path="organizations" element={<OrganizationsPage />} />
      <Route
        path="organizations/:organizationId"
        element={<OrganizationDetailPage />}
      />
      <Route path="account" element={<AccountPage />} />
      <Route path="student" element={<StudentDashboardPage />} />
      <Route path="student/roadmap" element={<StudentRoadmapPage />} />
      <Route path="student/learning" element={<StudentLearningPage />} />
      <Route path="student/activity" element={<StudentActivityPage />} />
      <Route path="student/deadlines" element={<StudentDeadlinesPage />} />
      <Route path="coordinator" element={<CoordinatorDashboardPage />} />
      <Route path="coordinator/cohorts" element={<CohortsPage />} />
      <Route
        path="coordinator/learning"
        element={<CoordinatorLearningPage />}
      />
      <Route
        path="coordinator/learning/:cohortId"
        element={<LiveCohortProgressPage />}
      />
      <Route
        path="coordinator/activity-plans/new"
        element={<ActivityPlanUploadPage />}
      />
      <Route
        path="coordinator/activity-plans/:planId"
        element={<ActivityPlanPage />}
      />
      <Route path="coordinator/roadmaps" element={<RoadmapsPage />} />
      <Route
        path="coordinator/roadmaps/:roadmapId/versions"
        element={<RoadmapVersionsPage />}
      />
      <Route path="coordinator/imports" element={<ImportsPage />} />
      <Route path="coordinator/students" element={<StudentProgressPage />} />
      <Route
        path="coordinator/topic-statistics"
        element={<TopicStatisticsPage />}
      />
      <Route path="coordinator/at-risk" element={<AtRiskPage />} />
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </>
)
