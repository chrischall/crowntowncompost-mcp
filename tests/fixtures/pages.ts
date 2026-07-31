// Hand-authored fixtures mirroring the real portal markup. The STRUCTURE here
// (class names, data-attrs, the responsive duplicated renewal date, the "Renews"
// short+long pair) was verified against the live signed-in portal 2026-07-31 by
// running the real parsers in-page and diffing their output; only the personal
// values are fake. See docs/CROWNTOWN-API.md.

export const DASHBOARD_HTML = `
<div class="account-status-container subscription-card">
  <div class="account-status-item"><span class="status-icon mb-2"></span>Account Status <span>Active</span></div>
  <div class="account-status-item"><span class="status-icon mb-2"></span>Active Subscriptions <span>1</span></div>
  <div class="account-status-item"><span class="status-icon mb-2"></span>Next Service <span>Aug. 7, 2026</span></div>
</div>
<div class="card subscription-card mb-4">
  <div class="card-header"><h5 class="mb-0">Subscription</h5>
    <span class="m-badge m-badge--wide">Active</span>
  </div>
  <div class="card-body">
    <h2 class="mb-0">$44.00/month</h2>
    <div>Renews <span class="d-lg-none">August 1</span><span class="d-none d-lg-block">August 1, 2026, 1:00 a.m.</span></div>
    <div class="plan-row">Weekly Residential Service <span>$44.00</span></div>
    <a href="/accounts/cancellation-request/">Request to Cancel</a>
  </div>
</div>
<div class="card subscription-card mb-4">
  <div class="card-header"><div class="d-flex align-items-center">
    <span class="card-header-icon mr-3"><i class="la la-map-marker"></i></span>
    <h5 class="mb-0">Service Address</h5>
  </div></div>
  <div class="card-body p-0"><div class="table-responsive">
    <table class="table table-hover mb-0">
      <thead><tr><th>Address</th><th>Service Day(s)</th><th>Actions</th></tr></thead>
      <tbody>
        <tr><td class="pl-4">123 Example Street</td><td class="align-middle">Friday</td><td class="text-right">Service History</td></tr>
        <tr><td class="pl-4">456 Second Ave</td><td class="align-middle">Tuesday</td><td class="text-right">Service History</td></tr>
      </tbody>
    </table>
  </div></div>
</div>`;

export const IMPACT_HTML = `
<div class="impact-stats">
  <div class="impact-stat"><h4>496 lbs diverted!</h4><p>This is the total weight we have collected from you so far.</p></div>
  <div class="impact-stat"><h4>3.3 seedlings planted!</h4><p>Composting has a huge impact on the environment.</p></div>
  <div class="impact-stat"><h4>492 miles offset!</h4><p>Your composting efforts are equivalent to not driving 492 miles.</p></div>
  <div class="impact-stat"><h4>22 gallons of gas!</h4><p>The number of gallons of gasoline offset.</p></div>
</div>`;

export const UPDATE_FORM_HTML = `
<form class="m-form" method="POST">
  <input type="hidden" name="csrfmiddlewaretoken" value="TESTCSRF">
  <input class="form-control" type="text" name="first_name" value="Test">
  <input class="form-control" type="text" name="last_name" value="User">
  <input class="form-control" type="text" name="phone" value="555-555-5555">
  <input type="checkbox" name="send_email_reminders">
  <input type="checkbox" name="service_notifications" checked>
  <button type="submit">Save</button>
</form>`;

export const CALENDAR_HTML = `
<div id="m_calendar">
  <div class="fc-event"><button class="btn m-btn btn-sm submit-skip" data-action="skip" data-clid="3360" data-rid="2815" data-route-date="Aug. 7, 2026" data-skip-has-credit="false">Skip Service</button></div>
  <div class="fc-event"><button class="btn m-btn btn-sm submit-skip" data-action="skip" data-clid="3360" data-rid="2827" data-route-date="Aug. 14, 2026" data-skip-has-credit="true">Skip Service</button></div>
  <div class="fc-event"><button class="btn m-btn btn-sm submit-skip" data-action="unskip" data-clid="3360" data-rid="2839" data-route-date="Aug. 21, 2026" data-skip-has-credit="false">Undo Skip</button></div>
  <div class="fc-event"><span class="not-skippable">Not Skippable</span></div>
</div>`;

/** The Django login page — used to assert expiry detection + CSRF extraction. */
export const LOGIN_PAGE_HTML = `
<form class="m-login__form m-form" action="/accounts/login/?next=/accounts/" method='POST'>
  <input type="hidden" name="csrfmiddlewaretoken" value="FORMTOKEN123">
  <input class="form-control m-input" type="text" required placeholder="Username or Email" name="username">
  <input class="form-control m-input" required type="password" placeholder="Password" name="password" id='password'>
  <button id="m_login_signin_submit" type='submit'>Sign In</button>
</form>`;
