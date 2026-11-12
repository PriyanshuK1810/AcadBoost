import { ProgressBar } from './WorkspaceUI'
import './cohort-report.css'

export default function ReportProgressTable({ rows, students = false }) {
  if (!Array.isArray(rows)) return <p>Completion data is unavailable.</p>
  if (!rows.length) return null
  return (
    <table className="cohort-report-table">
      <thead>
        <tr>
          <th scope="col">{students ? 'Student' : 'Topic'}</th>
          <th scope="col">Completed</th>
          <th scope="col">Completion</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const label = students ? row.name : row.title
          return (
            <tr key={row.id}>
              <th scope="row">{label}</th>
              <td>
                {Number.isFinite(row.completed) && Number.isFinite(row.total)
                  ? `${row.completed} / ${row.total} ${students ? 'topics' : 'eligible students'}`
                  : 'Unavailable'}
              </td>
              <td>
                {row.total > 0 && Number.isFinite(row.percent) ? (
                  <>
                    <ProgressBar
                      value={row.percent}
                      label={label + ' completion'}
                    />
                    <strong>{row.percent}%</strong>
                  </>
                ) : (
                  <span>—</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
