from datetime import datetime, timedelta


class WeeklyProcess:
    """
    Represent the process that we go through each week in order to send out the phone buddy list
    """

    def __init__(self, week_start_date, human_process_complete, admin_email_sent, phone_buddy_emails_sent, row_index):
        self.week_start_date = week_start_date
        self.is_current_week = week_start_date >= datetime.now() - timedelta(days=7)
        self.is_in_the_future = week_start_date > datetime.now()
        self.human_process_complete = human_process_complete
        self.admin_email_sent = admin_email_sent
        self.phone_buddy_emails_sent = phone_buddy_emails_sent
        self.row_index = row_index
        

    @staticmethod
    def parse_from_google_sheet_row(row_data, row_index):
        """
        Try to parse a WeeklyProcess object from the row data passed in.
        
        If a valid object can't be parsed, return None.
        """
        date_str, *process_steps = row_data

        try:
            date = datetime.strptime(date_str, "%A, %B %d, %Y")
        except ValueError:
            print("Invalid date - skipping")
            return None

        # Munge the process steps a bit before we try to parse them:
        # - add missing rows
        # - rewrite yes or y as Yes)
        process_steps += ["" for i in range(6 - len(process_steps))]
        process_steps = ["Yes" if value.upper() == "YES" or value.upper() == "Y" else value for value in process_steps]

        human_process_complete = False
        admin_email_sent = False
        phone_buddy_emails_sent = False

        # If the phone buddies sent box is checked, ignore everything else
        if process_steps[-1] == "Yes":
            phone_buddy_emails_sent = True
            admin_email_sent = True
            human_process_complete = True
        elif process_steps[-2] == "Yes":
            admin_email_sent = True
            human_process_complete = True
        elif all(step == 'Yes' for step in process_steps[:-2]):
            human_process_complete = True

        return WeeklyProcess(date, human_process_complete, admin_email_sent, phone_buddy_emails_sent, row_index)
