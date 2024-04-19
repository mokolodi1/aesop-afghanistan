import itertools

from phonebuddies.Buddy import Buddy
from phonebuddies.DatabaseConnector import DatabaseConnector
from phonebuddies.EmailInfo import EmailInfo
from phonebuddies.PhoneNumberParser import PhoneNumberParser


class EmailDraft:


    def __init__(self, to, subject, contents):
        # TODO: for development purposes, allow us to change the coming_from email via a file in secrets/
        # NOTE: likely break this into EmailDrafter and EmailDraft
        # (https://github.com/mokolodi1/aesop-afghanistan/issues/21)
        
        self.to = to
        self.coming_from = "phonebuddies@aesopafgahnistan.org"
        self.subject = subject
        self.contents = contents


    def __str__(self) -> str:
        return 'EmailDraft(to=%s; from=%s; subject="%s"; contents_length=%d)' % (self.to, self.coming_from, self.subject, len(self.contents))


    def _display_buddy_phone_number(buddy):
        phone_description = f"""<a href="{buddy.link_to_whatsapp()}">{buddy.whatsapp_phone}</a>"""

        # Display the original unparsed phone number in case we've changed it substantially
        if not PhoneNumberParser.numbers_are_similar:
            phone_description += f" (As entered by {buddy.pseudonym}: {buddy.phone})"

        return phone_description


    @staticmethod
    def _buddies_intro_table(first_buddy, second_buddy):
        """
        Static method to generate an HTML table with info for a buddy pair
        """

        return f"""
            <table style="width: 100%; border-collapse: collapse;">
                <tr>
                    <th style="border: 1px solid #cccccc; padding: 8px; text-align: left;"></th>
                    <th style="border: 1px solid #cccccc; padding: 8px; text-align: left;"><b>{ first_buddy.pseudonym }</b></th>
                    <th style="border: 1px solid #cccccc; padding: 8px; text-align: left;"><b>{ second_buddy.pseudonym }</b></th>
                </tr>
                <tr>
                    <td style="border: 1px solid #cccccc; padding: 8px;"><b>Buddy Type</b></td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ first_buddy.buddy_type }</td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ second_buddy.buddy_type }</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #cccccc; padding: 8px;"><b>Email</b></td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ first_buddy.email }</td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ second_buddy.email }</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #cccccc; padding: 8px;"><b>Phone</b></td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ EmailDraft._display_buddy_phone_number(first_buddy) }</td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ EmailDraft._display_buddy_phone_number(second_buddy) }</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #cccccc; padding: 8px;"><b>Location</b></td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ first_buddy.location }</td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ second_buddy.location }</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #cccccc; padding: 8px;"><b>Time zone</b></td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ first_buddy.time_zone }</td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ second_buddy.time_zone }</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #cccccc; padding: 8px;"><b>Introduction</b></td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ first_buddy.user_message }</td>
                    <td style="border: 1px solid #cccccc; padding: 8px;">{ second_buddy.user_message }</td>
                </tr>
            </table>

            """
    

    def draft_buddies_email(email_info: EmailInfo, first_buddy: Buddy, second_buddy: Buddy):
        to = [first_buddy.email, second_buddy.email]
        pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
        subject = "AESOP Phone buddy introduction: %s and %s" % pseudonyms

        name_and_name = "%s and %s" % pseudonyms

        # Keep the newlines in the email introduction
        introduction = email_info.introduction.replace("\n", "<br>")

        table_html = EmailDraft._buddies_intro_table(first_buddy, second_buddy)

        email_text = f"""
            <body>
                <p>Hello {name_and_name},</p>
                <p>{introduction}</p>
                <br>
                <p>{name_and_name}, you are AESOP phone buddies this week. Please find each of your contact information below.</p>
                <br>
                {table_html}
                <br>
                <p>
                    You can update your buddy information by submitting this form, which will overwrite any previous info.
                    Note that you'll have to fill out all the fields including those that already exist if this is your second time submitting it. 
                    <a href="https://forms.gle/c8UZ6BXSxGmkw5GN7">https://forms.gle/c8UZ6BXSxGmkw5GN7</a>
                </p>
                <p>{email_info.topic}</p>
                <p>Best,</p>
                <p>Your friendly AESOP Admin</p>
            </body>
            """
        
        return EmailDraft(to, subject, email_text)

    def draft_overdue_process_admin_reminder(email):
        message = f"""Hi AESOP Phone Buddy Admin,

Don't forget to fill out the Process sheet for the AESOP phone buddies!

{DatabaseConnector.get_database_link()}

Best,

Teo
"""

        return EmailDraft(email, "ACTION NEEDED: AESOP Phone Buddy Reminder", message)

    def draft_admins_without_buddy_emails(email):
            message = f"""The AESOP phone buddy emails were sent out.

This is a courtesy email given that you are an admin and did not have a buddy this week.

Any errors have been documented on the error tab here: {DatabaseConnector.get_database_link()}

Best,

Teo"""
            return EmailDraft(email, "AESOP Phone Buddy emails sent (you're an admin without a buddy)", message)